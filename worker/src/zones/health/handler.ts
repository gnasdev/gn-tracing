/**
 * GET /health — readiness without requiring secrets in the response.
 */

import type { Env } from "../../env";
import { isMcpEnabled } from "../../env";
import { jsonResponse } from "../../http/response";

export function isHealthPath(pathname: string): boolean {
  return pathname === "/health";
}

export function healthBody(env: Env): Record<string, unknown> {
  return {
    ok: true,
    service: "gn-tracing-oauth-proxy",
    providers: {
      google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
      dropbox: Boolean(env.DROPBOX_CLIENT_ID && env.DROPBOX_CLIENT_SECRET),
    },
    feedback: Boolean((env.GITHUB_FEEDBACK_TOKEN ?? "").trim()),
    mcp: isMcpEnabled(env),
  };
}

export function handleHealth(origin: string | null, env: Env): Response {
  // Soft CORS (feedback origin set) so the hosted player can probe readiness.
  return jsonResponse(healthBody(env), 200, origin, env, "feedback");
}
