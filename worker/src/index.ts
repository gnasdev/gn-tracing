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
 *   POST /feedback                     → create GitHub issue (opt-in product feedback)
 *   GET  /health                       → readiness (no secret required)
 *
 * The extension keeps PKCE end-to-end (code_verifier). This Worker only pins
 * client_id + client_secret and never stores tokens or returns secrets.
 *
 * Access is restricted to configured chrome-extension:// origins for OAuth.
 * Feedback additionally allows the hosted player web origins.
 *
 * Issue title/body formatting is imported from the extension shared pure module
 * (`src/shared/feedback-format.ts`) so client and Worker cannot drift.
 */

import {
  buildFeedbackIssueTitle,
  formatFeedbackIssueBody,
  normalizeFeedbackDiagnostics,
  validateFeedbackMessage,
} from "../../src/shared/feedback-format";

// Re-export formatters for worker unit tests (same functions as extension shared).
export { buildFeedbackIssueTitle, formatFeedbackIssueBody };

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

const FEEDBACK_RATE_LIMIT = 5;
const FEEDBACK_RATE_WINDOW_MS = 60 * 60 * 1000;

/** Default browser origins that may POST /feedback (standalone player). */
const DEFAULT_FEEDBACK_WEB_ORIGINS = [
  "https://tracing.gnas.dev",
  "http://localhost:5176",
  "http://127.0.0.1:5176",
];

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
  /**
   * Comma-separated web origins allowed for POST /feedback only
   * (standalone player). Empty → DEFAULT_FEEDBACK_WEB_ORIGINS.
   */
  ALLOWED_WEB_ORIGINS?: string;
  /** Fine-grained PAT or GitHub App token with issues:write on the target repo. */
  GITHUB_FEEDBACK_TOKEN?: string;
  GITHUB_REPO_OWNER?: string;
  GITHUB_REPO_NAME?: string;
  /** Comma-separated labels (default: feedback). Missing labels are retried without. */
  GITHUB_FEEDBACK_LABELS?: string;
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

export function isFeedbackPath(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/";
  return path === "/feedback";
}

function parseAllowedOrigins(env: Env): string[] {
  return (env.ALLOWED_EXTENSION_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseAllowedWebOrigins(env: Env): string[] {
  const raw = (env.ALLOWED_WEB_ORIGINS ?? "").trim();
  if (raw) {
    return raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }
  return [...DEFAULT_FEEDBACK_WEB_ORIGINS];
}

/** OAuth token exchange: extension origins only. */
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

/**
 * Feedback may come from the extension (chrome-extension://) or the hosted
 * standalone player (https://tracing.gnas.dev / local Vite).
 */
export function isFeedbackOriginAllowed(origin: string | null, env: Env): boolean {
  if (!origin) {
    return false;
  }
  if (isOriginAllowed(origin, env)) {
    return true;
  }
  return parseAllowedWebOrigins(env).includes(origin);
}

function corsHeaders(
  origin: string | null,
  env: Env,
  options: { feedback?: boolean } = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  const allowed = options.feedback
    ? isFeedbackOriginAllowed(origin, env)
    : isOriginAllowed(origin, env);
  if (origin && allowed) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function jsonResponse(
  body: unknown,
  status: number,
  origin: string | null,
  env: Env,
  options: { feedback?: boolean } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(origin, env, options),
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

function parseFeedbackLabels(env: Env): string[] {
  const raw = (env.GITHUB_FEEDBACK_LABELS ?? "feedback").trim();
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean)
    .slice(0, 5);
}

async function hashRateLimitKey(ip: string, hourBucket: number): Promise<string> {
  const data = new TextEncoder().encode(`${hourBucket}:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < 16; i += 1) {
    const byte = bytes[i];
    if (byte === undefined) {
      break;
    }
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Simple per-IP hourly rate limit via Cache API. Best-effort in multi-colo
 * deployments; still blocks casual spam from a single client IP.
 */
async function consumeFeedbackRateLimit(request: Request): Promise<{ allowed: boolean }> {
  const ip =
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown";
  const hourBucket = Math.floor(Date.now() / FEEDBACK_RATE_WINDOW_MS);
  const keyHash = await hashRateLimitKey(ip, hourBucket);
  const cacheKey = new Request(`https://feedback-rate.gn-tracing.local/${keyHash}`);

  try {
    // Cloudflare Workers expose `caches.default`; the DOM CacheStorage type does not.
    const cache = (caches as unknown as { default: Cache }).default;
    const existing = await cache.match(cacheKey);
    let count = 0;
    if (existing) {
      count = Number.parseInt(await existing.text(), 10) || 0;
    }
    if (count >= FEEDBACK_RATE_LIMIT) {
      return { allowed: false };
    }
    const next = count + 1;
    const maxAgeSec = Math.ceil(FEEDBACK_RATE_WINDOW_MS / 1000);
    await cache.put(
      cacheKey,
      new Response(String(next), {
        headers: {
          "Content-Type": "text/plain",
          "Cache-Control": `max-age=${maxAgeSec}`,
        },
      }),
    );
    return { allowed: true };
  } catch {
    // If Cache API is unavailable, allow the request rather than hard-fail feedback.
    return { allowed: true };
  }
}

async function createGitHubIssue(params: {
  token: string;
  owner: string;
  repo: string;
  title: string;
  body: string;
  labels: string[];
}): Promise<
  { ok: true; htmlUrl: string; number: number } | { ok: false; status: number; detail: string }
> {
  const endpoint = `https://api.github.com/repos/${params.owner}/${params.repo}/issues`;

  const post = async (includeLabels: boolean): Promise<Response> => {
    const payload: Record<string, unknown> = {
      title: params.title,
      body: params.body,
    };
    if (includeLabels && params.labels.length > 0) {
      payload.labels = params.labels;
    }
    return fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "gn-tracing-feedback-proxy",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify(payload),
    });
  };

  let response = await post(true);
  // Prefer creating the issue without labels over failing when a label is missing.
  if (
    !response.ok &&
    params.labels.length > 0 &&
    (response.status === 422 || response.status === 400)
  ) {
    response = await post(false);
  }

  if (!response.ok) {
    let detail = `GitHub API HTTP ${response.status}`;
    try {
      const errBody = (await response.json()) as { message?: string };
      if (errBody.message) {
        detail = errBody.message;
      }
    } catch {
      // keep status detail
    }
    return { ok: false, status: response.status, detail };
  }

  try {
    const data = (await response.json()) as { html_url?: string; number?: number };
    if (!data.html_url || typeof data.number !== "number") {
      return { ok: false, status: 502, detail: "GitHub API returned an unexpected issue payload." };
    }
    return { ok: true, htmlUrl: data.html_url, number: data.number };
  } catch {
    return { ok: false, status: 502, detail: "GitHub API returned invalid JSON." };
  }
}

async function handleFeedback(
  request: Request,
  env: Env,
  origin: string | null,
): Promise<Response> {
  const reply = (body: unknown, status: number) =>
    jsonResponse(body, status, origin, env, { feedback: true });

  const token = (env.GITHUB_FEEDBACK_TOKEN ?? "").trim();
  if (!token) {
    return reply(
      {
        error: "server_misconfigured",
        error_description:
          "Feedback is not configured on this Worker (missing GITHUB_FEEDBACK_TOKEN).",
      },
      503,
    );
  }

  const rate = await consumeFeedbackRateLimit(request);
  if (!rate.allowed) {
    return reply(
      {
        error: "rate_limited",
        error_description: "Too many feedback submissions. Please try again later.",
      },
      429,
    );
  }

  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return reply(
      { error: "invalid_request", error_description: "Request body must be JSON." },
      400,
    );
  }

  const validated = validateFeedbackMessage(payload.message);
  if (!validated.ok) {
    return reply({ error: "invalid_request", error_description: validated.error }, 400);
  }

  const diagnostics = normalizeFeedbackDiagnostics(payload.diagnostics);
  const title = buildFeedbackIssueTitle(validated.message);
  const body = formatFeedbackIssueBody(validated.message, diagnostics);
  const owner = (env.GITHUB_REPO_OWNER ?? "gnasdev").trim() || "gnasdev";
  const repo = (env.GITHUB_REPO_NAME ?? "gn-tracing").trim() || "gn-tracing";
  const labels = parseFeedbackLabels(env);

  let result: Awaited<ReturnType<typeof createGitHubIssue>>;
  try {
    result = await createGitHubIssue({
      token,
      owner,
      repo,
      title,
      body,
      labels,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return reply({ error: "upstream_unreachable", error_description: detail }, 502);
  }

  if (!result.ok) {
    const status = result.status >= 400 && result.status < 600 ? result.status : 502;
    return reply(
      {
        error: "github_error",
        error_description: result.detail,
      },
      status === 401 || status === 403 ? 502 : status,
    );
  }

  return reply(
    {
      ok: true,
      issueUrl: result.htmlUrl,
      issueNumber: result.number,
    },
    201,
  );
}

function healthBody(env: Env): Record<string, unknown> {
  return {
    ok: true,
    service: "gn-tracing-oauth-proxy",
    providers: {
      google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
      dropbox: Boolean(env.DROPBOX_CLIENT_ID && env.DROPBOX_CLIENT_SECRET),
    },
    feedback: Boolean((env.GITHUB_FEEDBACK_TOKEN ?? "").trim()),
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const feedbackRoute = isFeedbackPath(url.pathname);

    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse(healthBody(env), 200, origin, env, { feedback: true });
    }

    if (request.method === "OPTIONS") {
      const allowed = feedbackRoute
        ? isFeedbackOriginAllowed(origin, env)
        : isOriginAllowed(origin, env);
      if (!allowed) {
        return new Response(null, { status: 403 });
      }
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin, env, { feedback: feedbackRoute }),
      });
    }

    if (request.method !== "POST") {
      return jsonResponse(
        { error: "method_not_allowed", error_description: "Use POST." },
        405,
        origin,
        env,
        { feedback: feedbackRoute },
      );
    }

    if (feedbackRoute) {
      if (!isFeedbackOriginAllowed(origin, env)) {
        return jsonResponse(
          { error: "forbidden_origin", error_description: "Origin is not allowed." },
          403,
          origin,
          env,
          { feedback: true },
        );
      }
      return handleFeedback(request, env, origin);
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
          error_description: "Unknown endpoint. Use /token (Google), /token/dropbox, or /feedback.",
        },
        404,
        origin,
        env,
      );
    }

    return handleTokenExchange(request, env, origin, providerId);
  },
};
