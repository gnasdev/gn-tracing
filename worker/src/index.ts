/**
 * GN Tracing multi-issuer OAuth token-exchange proxy (Cloudflare Worker).
 *
 * The extension is a public client and must not ship OAuth client secrets.
 * This Worker holds secrets server-side and relays authorization_code /
 * refresh_token grants to each provider's token endpoint.
 *
 * Routes:
 *   POST /  | /token | /token/google   → Google
 *   POST /token/dropbox | /dropbox     → Dropbox
 *   GET  /health                       → readiness (no secret required)
 *
 * The extension keeps PKCE end-to-end (code_verifier). This Worker only pins
 * client_id + client_secret and never stores tokens or returns secrets.
 *
 * Access is restricted to configured chrome-extension:// origins.
 */

const ALLOWED_GRANT_TYPES = new Set(["authorization_code", "refresh_token"]);
// Fields the extension may forward. client_id / client_secret are injected.
const FORWARDED_FIELDS = [
  "grant_type",
  "code",
  "code_verifier",
  "redirect_uri",
  "refresh_token",
  "scope",
] as const;

export type OAuthProviderId = "google" | "dropbox";

export interface Env {
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  DROPBOX_CLIENT_SECRET?: string;
  DROPBOX_CLIENT_ID?: string;
  /**
   * Comma-separated allowed extension origins, e.g.
   * `chrome-extension://abc...,chrome-extension://def...`.
   * Empty → any `chrome-extension://` origin (dev fallback only).
   */
  ALLOWED_EXTENSION_ORIGINS?: string;
}

interface ProviderConfig {
  id: OAuthProviderId;
  tokenEndpoint: string;
  clientId: string | undefined;
  clientSecret: string | undefined;
  /** When true, missing clientSecret is a server misconfiguration. */
  requiresSecret: boolean;
  label: string;
}

function providerConfig(id: OAuthProviderId, env: Env): ProviderConfig {
  switch (id) {
    case "google":
      return {
        id,
        tokenEndpoint: "https://oauth2.googleapis.com/token",
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        requiresSecret: true,
        label: "Google",
      };
    case "dropbox":
      return {
        id,
        tokenEndpoint: "https://api.dropboxapi.com/oauth2/token",
        clientId: env.DROPBOX_CLIENT_ID,
        clientSecret: env.DROPBOX_CLIENT_SECRET,
        requiresSecret: true,
        label: "Dropbox",
      };
  }
}

/** Map request path to provider. Empty / legacy paths default to Google. */
export function resolveProviderFromPath(pathname: string): OAuthProviderId | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  switch (path) {
    case "/":
    case "/token":
    case "/token/google":
    case "/google":
      return "google";
    case "/token/dropbox":
    case "/dropbox":
      return "dropbox";
    default:
      return null;
  }
}

function parseAllowedOrigins(env: Env): string[] {
  return (env.ALLOWED_EXTENSION_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function isOriginAllowed(origin: string | null, env: Env): boolean {
  if (!origin) {
    return false;
  }

  const allowList = parseAllowedOrigins(env);
  if (allowList.length > 0) {
    return allowList.includes(origin);
  }

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
  providerId: OAuthProviderId,
): Promise<Response> {
  const provider = providerConfig(providerId, env);
  if (!provider.clientId) {
    return jsonResponse(
      {
        error: "server_misconfigured",
        error_description: `Worker is missing ${provider.label} client id for provider "${providerId}".`,
      },
      500,
      origin,
      env,
    );
  }
  if (provider.requiresSecret && !provider.clientSecret) {
    return jsonResponse(
      {
        error: "server_misconfigured",
        error_description: `Worker is missing ${provider.label} client secret for confidential provider "${providerId}".`,
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

  const upstream = new URLSearchParams();
  for (const field of FORWARDED_FIELDS) {
    const value = incoming.get(field);
    if (value) {
      upstream.set(field, value);
    }
  }
  // Pin client_id from the Worker (ignore any client-supplied values).
  // Only attach client_secret when the provider requires a confidential client.
  // Microsoft public clients reject secrets with AADSTS90023.
  upstream.set("client_id", provider.clientId);
  if (provider.clientSecret) {
    upstream.set("client_secret", provider.clientSecret);
  }

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(provider.tokenEndpoint, {
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

  const payloadText = await upstreamResponse.text();
  return new Response(payloadText, {
    status: upstreamResponse.status,
    headers: {
      "Content-Type": upstreamResponse.headers.get("Content-Type") ?? "application/json",
      ...corsHeaders(origin, env),
    },
  });
}

function healthBody(env: Env): Record<string, unknown> {
  return {
    ok: true,
    service: "gn-tracing-oauth-proxy",
    providers: {
      google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
      dropbox: Boolean(env.DROPBOX_CLIENT_ID && env.DROPBOX_CLIENT_SECRET),
    },
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse(healthBody(env), 200, origin, env);
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

    const providerId = resolveProviderFromPath(url.pathname);
    if (!providerId) {
      return jsonResponse(
        {
          error: "not_found",
          error_description: "Unknown endpoint. Use /token (Google) or /token/dropbox.",
        },
        404,
        origin,
        env,
      );
    }

    return handleTokenExchange(request, env, origin, providerId);
  },
};
