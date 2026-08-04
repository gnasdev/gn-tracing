/**
 * Google OAuth 2.0 domain ownership policy helpers.
 *
 * Policy: https://developers.google.com/identity/protocols/oauth2/policies#domains
 * ("Only use domains you own")
 *
 * Browser extensions must not register arbitrary web redirect URIs. Redirects
 * must use the platform-issued extension redirect hosts that Google / Mozilla
 * license for identity flows:
 *
 * - Chromium: https://<extension-id>.chromiumapp.org/
 * - Firefox:  https://<addon-id>.extensions.allizom.org/
 *
 * Custom domains (including the product homepage at tracing.gnas.dev) are for
 * consent-screen branding and privacy/terms pages — never as OAuth redirect
 * URIs for this extension.
 */

/** Hosts explicitly allowed as OAuth redirect_uri for this product. */
export const EXTENSION_OAUTH_REDIRECT_HOST_SUFFIXES = [
  ".chromiumapp.org",
  ".extensions.allizom.org",
] as const;

export type OAuthRedirectValidation =
  | { ok: true; redirectUri: string; hostname: string }
  | { ok: false; error: string };

/**
 * Validate a redirect URI against Google's domain-ownership rules for this
 * extension. Rejects http, IP literals, and any host that is not a platform
 * extension redirect domain.
 */
export function validateExtensionOAuthRedirectUri(raw: string): OAuthRedirectValidation {
  const trimmed = String(raw || "").trim();
  if (!trimmed) {
    return { ok: false, error: "OAuth redirect URI is empty." };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: "OAuth redirect URI is not a valid URL." };
  }

  if (url.protocol !== "https:") {
    return {
      ok: false,
      error: `OAuth redirect URI must use https (got ${url.protocol}).`,
    };
  }

  const hostname = url.hostname.toLowerCase();
  if (!hostname || hostname.includes("..")) {
    return { ok: false, error: "OAuth redirect URI hostname is invalid." };
  }

  // No IP literals or localhost — extension identity redirects are DNS names.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname === "localhost") {
    return {
      ok: false,
      error: "OAuth redirect URI must not use IP literals or localhost.",
    };
  }

  const allowed = EXTENSION_OAUTH_REDIRECT_HOST_SUFFIXES.some(
    (suffix) => hostname.endsWith(suffix) && hostname.length > suffix.length,
  );
  if (!allowed) {
    return {
      ok: false,
      error:
        "OAuth redirect URI must use a platform extension domain " +
        `(*.chromiumapp.org or *.extensions.allizom.org). Got host: ${hostname}. ` +
        "Do not register arbitrary web domains as redirect URIs " +
        "(Google OAuth domain ownership policy).",
    };
  }

  // Disallow userinfo / open redirects with unexpected ports.
  if (url.username || url.password) {
    return { ok: false, error: "OAuth redirect URI must not include credentials." };
  }
  if (url.port && url.port !== "443") {
    return { ok: false, error: "OAuth redirect URI must not use a custom port." };
  }

  return { ok: true, redirectUri: trimmed, hostname };
}

/**
 * Resolve chrome.identity.getRedirectURL() and validate it before launching
 * Google/Dropbox web auth.
 */
export function resolveValidatedIdentityRedirectUri(
  getRedirectURL: () => string = () => chrome.identity.getRedirectURL(),
): OAuthRedirectValidation {
  let raw: string;
  try {
    raw = getRedirectURL();
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? `Could not read identity redirect URL: ${error.message}`
          : "Could not read identity redirect URL.",
    };
  }
  return validateExtensionOAuthRedirectUri(raw);
}

/**
 * Canonical redirect for the running extension instance.
 * Prefer chrome.identity.getRedirectURL(); fall back to chrome.runtime.id so the
 * user can register the exact host even if identity is unavailable.
 */
export function resolveRuntimeExtensionRedirectUri(): OAuthRedirectValidation {
  const fromIdentity = resolveValidatedIdentityRedirectUri();
  if (fromIdentity.ok) {
    return fromIdentity;
  }
  try {
    const id = typeof chrome !== "undefined" && chrome.runtime?.id ? String(chrome.runtime.id) : "";
    if (!id) {
      return fromIdentity;
    }
    return validateExtensionOAuthRedirectUri(`https://${id}.chromiumapp.org/`);
  } catch {
    return fromIdentity;
  }
}

/** Debug fields for Connect UI / support (no secrets). */
export function describeOAuthRedirectDebug(extra: Record<string, string> = {}): string {
  const redirect = resolveRuntimeExtensionRedirectUri();
  const runtimeId =
    typeof chrome !== "undefined" && chrome.runtime?.id ? String(chrome.runtime.id) : "(unknown)";
  const lines = [
    `extensionId(runtime)=${runtimeId}`,
    redirect.ok
      ? `redirect_uri=${redirect.redirectUri}`
      : `redirect_uri=(invalid: ${redirect.error})`,
    // Suggest both slash variants — Google matches exactly.
    redirect.ok
      ? `also try without trailing slash: ${redirect.redirectUri.replace(/\/$/, "")}`
      : "",
    ...Object.entries(extra).map(([k, v]) => `${k}=${v}`),
  ].filter(Boolean);
  return lines.join("\n");
}
