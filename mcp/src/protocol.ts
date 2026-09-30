/**
 * Minimal Model Context Protocol server, transport-agnostic.
 *
 * MCP is JSON-RPC 2.0 with a small, stable method set (`initialize`,
 * `tools/list`, `tools/call`, `ping`). Implementing those four directly costs
 * ~150 lines and keeps this repo's dependency-free posture — the same reason the
 * extension vendors its zip writer instead of pulling a library. It also lets
 * the identical dispatcher run under Node stdio and inside workerd, which a
 * transport-coupled SDK would not.
 *
 * This module knows nothing about recordings: `handleMessage` takes a parsed
 * JSON-RPC message and a tool registry, and returns a response (or null for a
 * notification, which by spec gets no reply).
 */

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const DEFAULT_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export const JSON_RPC_VERSION = "2.0";

export const ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  /**
   * Implementation-defined range (-32000 … -32099). Used for transport refusals
   * that are neither a malformed request nor a tool failure — today only the
   * remote endpoint's per-IP rate limit.
   */
  rateLimited: -32000,
} as const;

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: string;
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: string;
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface ToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** What a tool returns before it is wrapped in MCP content blocks. */
export interface ToolOutcome {
  /** Structured payload, serialized as pretty JSON text content. */
  data?: unknown;
  /** Plain text payload (used by the Markdown report tool). */
  text?: string;
  isError?: boolean;
}

export interface ToolRegistry {
  list(): ToolDefinition[];
  call(name: string, args: Record<string, unknown>): Promise<ToolOutcome>;
}

export interface ServerInfo {
  name: string;
  version: string;
  /** Shown by clients that surface server guidance to the model. */
  instructions?: string;
}

export function successResponse(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: JSON_RPC_VERSION, id, result };
}

export function errorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: JSON_RPC_VERSION, id, error: { code, message, ...(data ? { data } : {}) } };
}

/**
 * Handles one parsed JSON-RPC message.
 *
 * Returns `null` when the message is a notification (no `id`), which the spec
 * says must not be answered.
 */
export async function handleMessage(
  message: unknown,
  tools: ToolRegistry,
  serverInfo: ServerInfo,
): Promise<JsonRpcResponse | null> {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return errorResponse(null, ERROR_CODES.invalidRequest, "Expected a JSON-RPC object.");
  }

  const request = message as JsonRpcRequest;
  const id = request.id ?? null;
  const isNotification = request.id === undefined;

  if (typeof request.method !== "string") {
    return isNotification
      ? null
      : errorResponse(id, ERROR_CODES.invalidRequest, "Missing JSON-RPC method.");
  }

  // Notifications are fire-and-forget; the only one that matters is
  // `notifications/initialized`, and even that needs no bookkeeping here.
  if (isNotification) {
    return null;
  }

  switch (request.method) {
    case "initialize":
      return successResponse(id, buildInitializeResult(request.params, serverInfo));

    case "ping":
      return successResponse(id, {});

    case "tools/list":
      return successResponse(id, { tools: tools.list() });

    case "tools/call":
      return handleToolCall(id, request.params, tools);

    default:
      return errorResponse(id, ERROR_CODES.methodNotFound, `Unknown method: ${request.method}`);
  }
}

/**
 * Handles a batch of already-parsed messages, dropping notification nulls.
 *
 * Both transports need exactly this loop — stdio over newline-delimited frames,
 * the Worker over a JSON array — and both need it serial: the recording cache in
 * `createRecordingStore` opens one package per id, so concurrent calls against a
 * fresh id would each download the zip directory before any of them populated
 * the cache.
 */
export async function dispatchMessages(
  messages: unknown[],
  tools: ToolRegistry,
  serverInfo: ServerInfo,
): Promise<JsonRpcResponse[]> {
  const responses: JsonRpcResponse[] = [];
  for (const message of messages) {
    const response = await handleMessage(message, tools, serverInfo);
    if (response) {
      responses.push(response);
    }
  }
  return responses;
}

function buildInitializeResult(
  params: Record<string, unknown> | undefined,
  serverInfo: ServerInfo,
): Record<string, unknown> {
  const requested = typeof params?.protocolVersion === "string" ? params.protocolVersion : "";
  const protocolVersion = (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : DEFAULT_PROTOCOL_VERSION;

  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: serverInfo.name, version: serverInfo.version },
    ...(serverInfo.instructions ? { instructions: serverInfo.instructions } : {}),
  };
}

async function handleToolCall(
  id: JsonRpcId,
  params: Record<string, unknown> | undefined,
  tools: ToolRegistry,
): Promise<JsonRpcResponse> {
  const name = typeof params?.name === "string" ? params.name : "";
  if (!name) {
    return errorResponse(id, ERROR_CODES.invalidParams, "tools/call requires a tool name.");
  }

  const args =
    params?.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
      ? (params.arguments as Record<string, unknown>)
      : {};

  try {
    const outcome = await tools.call(name, args);
    return successResponse(id, toToolResult(outcome));
  } catch (cause) {
    // Tool failures are *results*, not protocol errors: the model should see the
    // message and adjust, rather than the client treating the call as broken.
    const message = cause instanceof Error ? cause.message : String(cause);
    const code = (cause as { code?: string } | undefined)?.code;
    return successResponse(
      id,
      toToolResult({
        data: {
          error: { code: code ?? "TOOL_FAILED", message, hint: (cause as { hint?: string })?.hint },
        },
        isError: true,
      }),
    );
  }
}

function toToolResult(outcome: ToolOutcome): Record<string, unknown> {
  const text =
    outcome.text !== undefined ? outcome.text : JSON.stringify(outcome.data ?? null, null, 2);
  return {
    content: [{ type: "text", text }],
    ...(outcome.isError ? { isError: true } : {}),
  };
}

/** Parses one line of newline-delimited JSON-RPC, tolerating blank lines. */
export function parseJsonRpcLine(line: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = line.trim();
  if (!trimmed) {
    return { ok: false };
  }
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    return { ok: false };
  }
}
