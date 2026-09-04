/**
 * Remote MCP endpoint: `POST /mcp`.
 *
 * Same protocol dispatcher and same tool surface as the local stdio server
 * (`mcp/src/`), so a hosted agent and a local one see identical tools. What
 * differs is what the transport is allowed to do:
 *
 * - **Hosted recordings only.** No local files, and no package passwords — a
 *   password must never travel to a public endpoint.
 * - **Stateless.** Recording ids are self-describing (`gdrive:<id>`), so any
 *   worker instance can serve a follow-up call with no shared session store.
 * - **Bounded.** Package and entry size caps plus a per-IP rate limit; anything
 *   over the limit is told to use the local server instead.
 * - **Quiet.** Nothing here logs a file id, URL, or recording content.
 *
 * The upstream fetch goes through the player's own download proxies, which
 * already enforce the provider id allow-list that keeps this from being a
 * general-purpose fetcher.
 */

import {
  dispatchMessages,
  ERROR_CODES,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "../../../../mcp/src/protocol";
import { createToolRegistry, SERVER_INSTRUCTIONS } from "../../../../mcp/src/tools";
import { MCP_SERVER_VERSION } from "../../../../mcp/src/version";
import { type Env, isMcpEnabled } from "../../env";
import { readJsonBody } from "../../http/body";
import { mcpRateLimiter } from "../../middleware/rate-limit";
import { MAX_BATCH_MESSAGES, MAX_REQUEST_BODY_BYTES } from "./limits";
import { createRemoteRecordingStore } from "./remote-store";

export type McpEnv = Pick<Env, "MCP_ENABLED" | "PLAYER_ORIGIN">;

export const MCP_SERVER_INFO = {
  name: "gn-tracing-remote",
  version: MCP_SERVER_VERSION,
  instructions: SERVER_INSTRUCTIONS,
};

export function isMcpPath(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/";
  return path === "/mcp";
}

/**
 * CORS for `/mcp` is deliberately open.
 *
 * The endpoint holds no user credentials and serves only recordings that are
 * already public-by-link, so an origin allow-list would block legitimate
 * browser-based MCP clients without protecting anything. Abuse is bounded by the
 * provider id allow-list and the rate limit instead.
 */
export function mcpCorsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Mcp-Session-Id, Mcp-Protocol-Version",
    "Access-Control-Max-Age": "86400",
    "X-Content-Type-Options": "nosniff",
  };
}

function jsonRpcError(code: number, message: string, status = 200): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message } }), {
    status,
    headers: { "Content-Type": "application/json", ...mcpCorsHeaders() },
  });
}

export async function handleMcpRequest(request: Request, env: McpEnv): Promise<Response> {
  if (!isMcpEnabled(env)) {
    return jsonRpcError(
      ERROR_CODES.methodNotFound,
      "The remote MCP endpoint is disabled on this deployment.",
      404,
    );
  }

  // A JSON content type is required, not just conventional: `text/plain` is
  // CORS-simple, so without this any page could POST here from a visitor's
  // browser with no preflight, spending that visitor's IP and rate-limit budget
  // on requests they never made.
  const essence = (request.headers.get("Content-Type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (essence !== "application/json" && !essence?.endsWith("+json")) {
    return jsonRpcError(
      ERROR_CODES.invalidRequest,
      "Send a JSON-RPC message with Content-Type: application/json.",
      415,
    );
  }

  // MCP requires a 400 for an unsupported `MCP-Protocol-Version`. An absent
  // header is legal — the spec tells the server to assume `2025-03-26` — so only
  // a present-and-unknown value fails.
  const protocolVersion = request.headers.get("MCP-Protocol-Version");
  if (
    protocolVersion != null &&
    !(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(protocolVersion.trim())
  ) {
    return jsonRpcError(
      ERROR_CODES.invalidRequest,
      `Unsupported MCP-Protocol-Version. This server speaks ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}.`,
      400,
    );
  }

  if (!(await mcpRateLimiter.consume(request)).allowed) {
    return jsonRpcError(
      ERROR_CODES.rateLimited,
      "Rate limit reached for this IP. Try again later, or run the local gn-tracing MCP server.",
      429,
    );
  }

  // Reads the body itself rather than trusting Content-Length: a chunked or
  // header-less POST declares no length, so a header-only check would wave
  // through an arbitrarily large body straight into JSON.parse.
  const body = await readJsonBody(request, MAX_REQUEST_BODY_BYTES);
  if (!body.ok) {
    return body.reason === "too_large"
      ? jsonRpcError(ERROR_CODES.invalidRequest, "Request body is too large.", 413)
      : jsonRpcError(ERROR_CODES.parseError, "Could not parse JSON-RPC message.", 400);
  }

  const batched = Array.isArray(body.value);
  const messages = batched ? (body.value as unknown[]) : [body.value];
  if (messages.length > MAX_BATCH_MESSAGES) {
    return jsonRpcError(
      ERROR_CODES.invalidRequest,
      `A batch may hold at most ${MAX_BATCH_MESSAGES} messages. Send them as separate requests.`,
      413,
    );
  }

  const store = createRemoteRecordingStore(env);
  const tools = createToolRegistry(store);
  const responses = await dispatchMessages(messages.map(stripPassword), tools, MCP_SERVER_INFO);

  // A body of nothing but notifications yields no response at all.
  if (responses.length === 0) {
    return new Response(null, { status: 202, headers: mcpCorsHeaders() });
  }

  return new Response(JSON.stringify(batched ? responses : responses[0]), {
    status: 200,
    headers: { "Content-Type": "application/json", ...mcpCorsHeaders() },
  });
}

/**
 * Drops any `password` argument before dispatch.
 *
 * Package passwords are for local use; accepting one here would invite users to
 * send a secret to a public endpoint. Encrypted packages fail with a message
 * pointing at the local server.
 */
function stripPassword(message: unknown): unknown {
  if (!message || typeof message !== "object") {
    return message;
  }
  const request = message as { params?: { arguments?: Record<string, unknown> } };
  if (request.params?.arguments && "password" in request.params.arguments) {
    const { password: _password, ...rest } = request.params.arguments;
    return { ...message, params: { ...request.params, arguments: rest } };
  }
  return message;
}
