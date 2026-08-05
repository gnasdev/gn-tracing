/**
 * Worker environment bindings and allow-list parsers.
 *
 * Secrets (wrangler secret): GOOGLE_CLIENT_SECRET, DROPBOX_CLIENT_SECRET,
 * GITHUB_FEEDBACK_TOKEN. Public vars live in wrangler.toml [vars].
 */

/** Default browser origins that may POST /feedback (standalone player). */
export const DEFAULT_FEEDBACK_WEB_ORIGINS = [
  "https://tracing.gnas.dev",
  "http://localhost:5176",
  "http://127.0.0.1:5176",
] as const;

export interface Env {
  GOOGLE_CLIENT_SECRET?: string;
  /** Chrome Extension client id (optional on Worker). */
  GOOGLE_CLIENT_ID?: string;
  /** Web application client id for token proxy (preferred over GOOGLE_CLIENT_ID). */
  GOOGLE_WEB_CLIENT_ID?: string;
  DROPBOX_CLIENT_SECRET?: string;
  DROPBOX_CLIENT_ID?: string;
  /**
   * Comma-separated allowed extension origins, e.g.
   * `chrome-extension://abc...,chrome-extension://def...`.
   * Firefox origins are random per install — add the sentinel
   * `moz-extension://*` to accept any of them.
   * Empty → any extension-scheme origin (dev fallback only), unless
   * STRICT_ORIGIN is enabled.
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
  /** Set to "false" to disable the remote MCP endpoint (`POST /mcp`). */
  MCP_ENABLED?: string;
  /** Player origin whose /api/* proxies stream recording package bytes. */
  PLAYER_ORIGIN?: string;
  /**
   * When "true" / "1" / "on", an empty ALLOWED_EXTENSION_ORIGINS is a
   * misconfiguration (fail closed) instead of accepting any chrome-extension://.
   */
  STRICT_ORIGIN?: string;
}

export function parseCommaList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function parseAllowedExtensionOrigins(env: Env): string[] {
  return parseCommaList(env.ALLOWED_EXTENSION_ORIGINS);
}

export function parseAllowedWebOrigins(env: Env): string[] {
  const raw = (env.ALLOWED_WEB_ORIGINS ?? "").trim();
  if (raw) {
    return parseCommaList(raw);
  }
  return [...DEFAULT_FEEDBACK_WEB_ORIGINS];
}

export function isStrictOrigin(env: Env): boolean {
  const raw = (env.STRICT_ORIGIN ?? "").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "on";
}

export function isMcpEnabled(env: Pick<Env, "MCP_ENABLED">): boolean {
  const raw = (env.MCP_ENABLED ?? "").trim().toLowerCase();
  return raw !== "false" && raw !== "0" && raw !== "off";
}
