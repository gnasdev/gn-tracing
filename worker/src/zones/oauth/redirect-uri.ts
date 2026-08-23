/**
 * Reject authorization_code exchanges whose redirect_uri is not a platform
 * extension identity host (Google OAuth domain ownership policy).
 *
 * Must stay aligned with root `src/shared/oauth-redirect-policy.ts`.
 */

const ALLOWED_SUFFIXES = [".chromiumapp.org", ".extensions.allizom.org"] as const;
const FIREFOX_MOZOAUTH2_PREFIX = "http://127.0.0.1/mozoauth2/";
/**
 * Safari (macOS + iOS) has no identity API at all — no `chromiumapp.org`-style
 * pseudo-domain, no mozoauth2 loopback. It uses a `/oauth-callback` page on the
 * player host instead (see src/shared/oauth-redirect-policy.ts
 * SAFARI_OAUTH_CALLBACK_URL and src/background/safari-web-auth-flow.ts).
 * Exact-match allowlist entries, not a suffix, since these are specific known
 * pages this project controls, not a per-install platform-issued host.
 *
 * Both dev and prod values are allowed unconditionally (same as the Firefox
 * mozoauth2 loopback above): a dev extension build routes its token exchange
 * to the local dev Worker, never this deployed one, so accepting the
 * localhost value here has no practical effect on the deployed Worker's real
 * traffic — it only matters when this same source runs locally via
 * `wrangler dev`, which is exactly when a dev Safari build needs it.
 */
const SAFARI_OAUTH_CALLBACK_URLS = [
  "https://tracing.gnas.dev/oauth-callback",
  "http://localhost:5176/oauth-callback",
] as const;

export function isAllowedExtensionOAuthRedirectUri(raw: string): {
  ok: boolean;
  error?: string;
} {
  const trimmed = String(raw || "").trim();
  if (!trimmed) {
    return { ok: false, error: "redirect_uri is required for authorization_code." };
  }

  // Firefox 86+ loopback form used with Google / Dropbox web auth.
  const mozo = trimmed.replace(/\/+$/, "");
  if (mozo.startsWith(FIREFOX_MOZOAUTH2_PREFIX)) {
    const sub = mozo.slice(FIREFOX_MOZOAUTH2_PREFIX.length);
    if (!sub || sub.includes("/") || sub.includes("..") || sub.includes("?") || sub.includes("#")) {
      return { ok: false, error: "redirect_uri mozoauth2 path is invalid." };
    }
    return { ok: true };
  }

  // Email-style allizom raw strings (client usually converts to mozoauth2 first).
  const allizomMatch = trimmed
    .replace(/\/+$/, "")
    .match(/^https:\/\/(.+)\.extensions\.allizom\.org$/i);
  if (allizomMatch?.[1] && !allizomMatch[1].includes("/")) {
    return { ok: true };
  }

  // Safari: exact match only, not a suffix — these are specific pages this
  // project controls, not a per-install platform-issued host.
  if ((SAFARI_OAUTH_CALLBACK_URLS as readonly string[]).includes(trimmed.replace(/\/+$/, ""))) {
    return { ok: true };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: "redirect_uri is not a valid URL." };
  }
  if (url.protocol !== "https:") {
    return { ok: false, error: "redirect_uri must use https." };
  }
  const hostname = url.hostname.toLowerCase();
  if (!hostname || hostname === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    return { ok: false, error: "redirect_uri host is not an allowed extension domain." };
  }
  const allowed = ALLOWED_SUFFIXES.some(
    (suffix) => hostname.endsWith(suffix) && hostname.length > suffix.length,
  );
  if (!allowed) {
    return {
      ok: false,
      error:
        "redirect_uri must be a platform extension domain (*.chromiumapp.org, *.extensions.allizom.org, or Firefox mozoauth2 loopback).",
    };
  }
  if (url.username || url.password || (url.port && url.port !== "443")) {
    return { ok: false, error: "redirect_uri must not include credentials or a custom port." };
  }
  return { ok: true };
}
