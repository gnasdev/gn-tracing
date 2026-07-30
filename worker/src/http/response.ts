/**
 * Shared HTTP response builders for the OAuth / feedback / health zones.
 * MCP uses its own JSON-RPC envelope + open CORS (see zones/mcp).
 */

import type { Env } from "../env";
import { buildCorsHeaders, type CorsZone } from "../middleware/cors";

export function jsonResponse(
  body: unknown,
  status: number,
  origin: string | null,
  env: Env,
  zone: CorsZone = "oauth",
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "X-Content-Type-Options": "nosniff",
      ...buildCorsHeaders(origin, env, zone),
    },
  });
}

export function emptyResponse(
  status: number,
  origin: string | null,
  env: Env,
  zone: CorsZone,
): Response {
  return new Response(null, {
    status,
    headers: buildCorsHeaders(origin, env, zone),
  });
}

export function passthroughUpstream(
  payloadText: string,
  upstream: Response,
  origin: string | null,
  env: Env,
  zone: CorsZone = "oauth",
): Response {
  return new Response(payloadText, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") ?? "application/json",
      "X-Content-Type-Options": "nosniff",
      ...buildCorsHeaders(origin, env, zone),
    },
  });
}
