/**
 * GN Tracing OAuth token-exchange proxy (Cloudflare Worker).
 *
 * Google rejects PKCE-only token requests when the OAuth client is registered
 * as a "Web application" (it requires a `client_secret`). The extension is a
 * public client and must not ship a secret, so this Worker holds the
 * `client_secret` and performs the token exchange server-side.
 *
 * The extension keeps PKCE end-to-end: it still generates the `code_verifier`
 * and forwards it here. This Worker only appends `client_secret` (and pins
 * `client_id`) before relaying the request to Google's token endpoint. It never
 * stores tokens and never returns the secret.
 *
 * Supported grants (POST, application/x-www-form-urlencoded or JSON):
 *   - grant_type=authorization_code  (code, code_verifier, redirect_uri)
 *   - grant_type=refresh_token       (refresh_token)
 *
 * Access is restricted to the configured extension origin(s) via Origin checks
 * so the endpoint cannot be used as an open token-minting proxy.
 */

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const ALLOWED_GRANT_TYPES = new Set(["authorization_code", "refresh_token"]);
// Fields the extension is allowed to forward. `client_id`/`client_secret` are
// injected by the Worker and intentionally excluded from this allow-list.
const FORWARDED_FIELDS = ["grant_type", "code", "code_verifier", "redirect_uri", "refresh_token"];

export interface Env {
  /** Google OAuth client secret. Set via `wrangler secret put GOOGLE_CLIENT_SECRET`. */
  GOOGLE_CLIENT_SECRET: string;
  /** Google OAuth client id (the "Web application" client). Public value. */
  GOOGLE_CLIENT_ID: string;
  /**
   * Comma-separated list of allowed extension origins, e.g.
   * `chrome-extension://abc...,chrome-extension://def...`.
   * If empty, all `chrome-extension://` origins are allowed (not recommended
   * for production, but lets local unpacked builds work during development).
   */
  ALLOWED_EXTENSION_ORIGINS?: string;
}

function parseAllowedOrigins(env: Env): string[] {
  return (env.ALLOWED_EXTENSION_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function isOriginAllowed(origin: string | null, env: Env): boolean {
  if (!origin) {
    // Non-browser callers (no Origin header) are rejected; the extension's
    // service worker always sends an Origin for cross-origin fetches.
    return false;
  }

  const allowList = parseAllowedOrigins(env);
  if (allowList.length > 0) {
    return allowList.includes(origin);
  }

  // Permissive fallback: any extension origin. Lock this down in production by
  // setting ALLOWED_EXTENSION_ORIGINS.
  return origin.startsWith("chrome-extension://");
}

function corsHeaders(origin: string | null, env: Env): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (origin && isOriginAllowed(origin, env)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function jsonResponse(body: unknown, status: number, origin: string | null, env: Env): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(origin, env),
    },
  });
}

async function readRequestParams(request: Request): Promise<URLSearchParams> {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (contentType.includes("application/json")) {
    const data = (await request.json()) as Record<string, unknown>;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === "string") {
        params.set(key, value);
      }
    }
    return params;
  }
  const text = await request.text();
  return new URLSearchParams(text);
}

async function handleTokenExchange(
  request: Request,
  env: Env,
  origin: string | null,
): Promise<Response> {
  if (!env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_CLIENT_ID) {
    return jsonResponse(
      {
        error: "server_misconfigured",
        error_description: "Worker is missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET.",
      },
      500,
      origin,
      env,
    );
  }

  let incoming: URLSearchParams;
  try {
    incoming = await readRequestParams(request);
  } catch {
    return jsonResponse(
      { error: "invalid_request", error_description: "Malformed request body." },
      400,
      origin,
      env,
    );
  }

  const grantType = incoming.get("grant_type") ?? "";
  if (!ALLOWED_GRANT_TYPES.has(grantType)) {
    return jsonResponse(
      {
        error: "unsupported_grant_type",
        error_description: `grant_type must be one of: ${[...ALLOWED_GRANT_TYPES].join(", ")}.`,
      },
      400,
      origin,
      env,
    );
  }

  // Build the upstream request from an allow-list, then inject credentials.
  const upstream = new URLSearchParams();
  for (const field of FORWARDED_FIELDS) {
    const value = incoming.get(field);
    if (value) {
      upstream.set(field, value);
    }
  }
  upstream.set("client_id", env.GOOGLE_CLIENT_ID);
  upstream.set("client_secret", env.GOOGLE_CLIENT_SECRET);

  let googleResponse: Response;
  try {
    googleResponse = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: upstream,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return jsonResponse(
      { error: "upstream_unreachable", error_description: detail },
      502,
      origin,
      env,
    );
  }

  // Relay Google's response verbatim (status + JSON) so the extension's
  // existing error handling keeps working unchanged.
  const payloadText = await googleResponse.text();
  return new Response(payloadText, {
    status: googleResponse.status,
    headers: {
      "Content-Type": googleResponse.headers.get("Content-Type") ?? "application/json",
      ...corsHeaders(origin, env),
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    // Unauthenticated health check for deploy verification.
    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({ ok: true, service: "gn-tracing-oauth-proxy" }, 200, origin, env);
    }

    if (request.method === "OPTIONS") {
      if (!isOriginAllowed(origin, env)) {
        return new Response(null, { status: 403 });
      }
      return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
    }

    if (request.method !== "POST") {
      return jsonResponse(
        { error: "method_not_allowed", error_description: "Use POST." },
        405,
        origin,
        env,
      );
    }

    if (!isOriginAllowed(origin, env)) {
      return jsonResponse(
        { error: "forbidden_origin", error_description: "Origin is not allowed." },
        403,
        origin,
        env,
      );
    }

    if (url.pathname === "/" || url.pathname === "/token") {
      return handleTokenExchange(request, env, origin);
    }

    return jsonResponse(
      { error: "not_found", error_description: "Unknown endpoint." },
      404,
      origin,
      env,
    );
  },
};
