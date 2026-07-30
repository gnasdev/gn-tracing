/**
 * CORS headers per capability zone.
 *
 * OAuth and feedback echo an allowed Origin. MCP uses open CORS (see zones/mcp).
 */

import type { Env } from "../env";
import { isExtensionOriginAllowed, isFeedbackOriginAllowed } from "./origin";

/** OAuth is extension-only; feedback (and health) use the softer web allow-list. */
export type CorsZone = "oauth" | "feedback";

export function buildCorsHeaders(
  origin: string | null,
  env: Env,
  zone: CorsZone,
): Record<string, string> {
  const headers: Record<string, string> = {
    // Match historical Worker headers for all non-MCP zones (including GET /health).
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };

  // Health reuses the softer feedback origin set so the player can probe readiness.
  const allowed =
    zone === "oauth" ? isExtensionOriginAllowed(origin, env) : isFeedbackOriginAllowed(origin, env);

  if (origin && allowed) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}
