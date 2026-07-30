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

import { handleMessage } from "../../../../mcp/src/protocol";
import { createToolRegistry, SERVER_INSTRUCTIONS } from "../../../../mcp/src/tools";
import type { Env } from "../../env";
import { isMcpEnabled } from "../../env";
import { isDeclaredBodyTooLarge } from "../../http/body";
import { mcpRateLimiter } from "../../middleware/rate-limit";
import { MAX_REMOTE_ENTRY_BYTES, MAX_REMOTE_PACKAGE_BYTES, MAX_REQUEST_BODY_BYTES } from "./limits";
import { createRemoteRecordingStore } from "./remote-store";

export interface McpEnv {
  MCP_ENABLED?: string;
  PLAYER_ORIGIN?: string;
}

export const MCP_SERVER_INFO = {
  name: "gn-tracing-remote",
  version: "1.0.0",
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
    return jsonRpcError(-32601, "The remote MCP endpoint is disabled on this deployment.", 404);
  }

  if (isDeclaredBodyTooLarge(request, MAX_REQUEST_BODY_BYTES)) {
    return jsonRpcError(-32600, "Request body is too large.", 413);
  }

  if (!(await mcpRateLimiter.consume(request)).allowed) {
    return jsonRpcError(
      -32000,
      "Rate limit reached for this IP. Try again later, or run the local gn-tracing MCP server.",
      429,
    );
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return jsonRpcError(-32700, "Could not parse JSON-RPC message.", 400);
  }

  const store = createRemoteRecordingStore(env);
  const tools = createToolRegistry(store);

  // A batch is a JSON array of messages; notifications produce no response.
  const messages = Array.isArray(payload) ? payload : [payload];
  const responses = [];
  for (const message of messages) {
    const response = await handleMessage(stripPassword(message), tools, MCP_SERVER_INFO);
    if (response) {
      responses.push(response);
    }
  }

  if (responses.length === 0) {
    return new Response(null, { status: 202, headers: mcpCorsHeaders() });
  }

  return new Response(JSON.stringify(Array.isArray(payload) ? responses : responses[0]), {
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

// Env-shaped helper re-export for tests that imported isMcpEnabled from mcp-route.
export {
  createRemoteRecordingStore,
  isMcpEnabled,
  MAX_REMOTE_ENTRY_BYTES,
  MAX_REMOTE_PACKAGE_BYTES,
};
