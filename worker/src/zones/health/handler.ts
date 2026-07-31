/**
 * GET /health and GET /{productVersion}/health — readiness without secrets.
 */

import type { Env } from "../../env";
import { isMcpEnabled } from "../../env";
import { jsonResponse } from "../../http/response";
import { PRODUCT_VERSION } from "../../product-version";

/** True for remainder path `/health` (after optional version strip). */
export function isHealthPath(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/";
  return path === "/health";
}

export function healthBody(
  env: Env,
  requestRouteVersion: string | null = null,
): Record<string, unknown> {
  return {
    ok: true,
    service: "gn-tracing-oauth-proxy",
    version: PRODUCT_VERSION,
    requestRouteVersion,
    providers: {
      google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
      dropbox: Boolean(env.DROPBOX_CLIENT_ID && env.DROPBOX_CLIENT_SECRET),
    },
    feedback: Boolean((env.GITHUB_FEEDBACK_TOKEN ?? "").trim()),
    mcp: isMcpEnabled(env),
  };
}

export function handleHealth(
  origin: string | null,
  env: Env,
  requestRouteVersion: string | null = null,
): Response {
  // Soft CORS (feedback origin set) so the hosted player can probe readiness.
  return jsonResponse(healthBody(env, requestRouteVersion), 200, origin, env, "feedback");
}
