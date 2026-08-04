/**
 * Reject authorization_code exchanges whose redirect_uri is not a platform
 * extension identity host (Google OAuth domain ownership policy).
 *
 * Must stay aligned with root `src/shared/oauth-redirect-policy.ts`.
 */

const ALLOWED_SUFFIXES = [".chromiumapp.org", ".extensions.allizom.org"] as const;

export function isAllowedExtensionOAuthRedirectUri(raw: string): {
  ok: boolean;
  error?: string;
} {
  const trimmed = String(raw || "").trim();
  if (!trimmed) {
    return { ok: false, error: "redirect_uri is required for authorization_code." };
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
        "redirect_uri must be a platform extension domain (*.chromiumapp.org or *.extensions.allizom.org).",
    };
  }
  if (url.username || url.password || (url.port && url.port !== "443")) {
    return { ok: false, error: "redirect_uri must not include credentials or a custom port." };
  }
  return { ok: true };
}
