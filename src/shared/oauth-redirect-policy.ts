/**
 * Google OAuth 2.0 domain ownership policy helpers.
 *
 * Policy: https://developers.google.com/identity/protocols/oauth2/policies#domains
 * ("Only use domains you own")
 *
 * Browser extensions must not register arbitrary web redirect URIs. Redirects
 * must use the platform-issued extension identity hosts:
 *
 * - Chromium: https://<extension-id>.chromiumapp.org/
 * - Firefox:  http://127.0.0.1/mozoauth2/<sha1(addonId)>
 *   Firefox identity.getRedirectURL() uses SHA-1 of the addon id as the
 *   allizom subdomain (NOT the raw email-style id). launchWebAuthFlow also
 *   accepts the mozoauth2 loopback form with that same hash (Firefox 86+).
 * - Safari (macOS + iOS): no platform identity host at all — Safari has no
 *   `identity` API (confirmed: `safari-web-extension-converter` flags the
 *   `identity` manifest permission itself as unsupported). There is nothing
 *   for `chrome.identity.launchWebAuthFlow`/`getRedirectURL()` to key off, so
 *   Safari uses a `/oauth-callback` page on the player host instead
 *   (SAFARI_OAUTH_CALLBACK_URL — same dev/prod split as the player itself:
 *   `http://localhost:$PLAYER_LOCAL_PORT/oauth-callback` in development,
 *   `https://tracing.gnas.dev/oauth-callback` in production) and
 *   `src/background/safari-web-auth-flow.ts` drives the flow with
 *   chrome.tabs.create + tabs.onUpdated rather than the identity API. Both
 *   hosts are domain-ownership-compliant: tracing.gnas.dev is a domain this
 *   project owns, and Google/Dropbox both explicitly exempt `http://localhost`
 *   redirect URIs from the https requirement (same reason the Firefox
 *   mozoauth2 loopback above works) — no reason for a dev build to exercise
 *   the production callback and production OAuth Worker just to test locally.
 *
 * Other custom domains are for consent-screen branding and privacy/terms
 * pages — never as OAuth redirect URIs for this extension.
 */

import { getBrowserTarget } from "../platform/detect";
import type { BrowserTarget } from "../platform/types";
import { resolvePlayerHostUrl } from "./player-host";
import { sha1Hex } from "./sha1";

declare const __APP_ENV__: string;
declare const __PLAYER_LOCAL_PORT__: string;
declare const __PLAYER_HOST_URL__: string;

/**
 * Safari OAuth callback: `/oauth-callback` on the player host (see
 * `player/public/oauth-callback/`), resolved with the exact same dev/prod
 * split `resolveReplayOpenUrl`/`buildExternalPlayerUrl` already use. Must be
 * registered as an Authorized redirect URI on the Google/Dropbox Web
 * application OAuth clients (both the localhost:5176 dev value and the
 * tracing.gnas.dev production value). The extension never lets this page
 * actually finish loading in normal operation — `launchSafariWebAuthFlow`
 * closes the tab as soon as its URL changes to this prefix, reading
 * `code`/`state` off the URL the same way the other platforms'
 * identity-redirect result is parsed.
 */
export const SAFARI_OAUTH_CALLBACK_URL = `${resolvePlayerHostUrl(
  typeof __PLAYER_HOST_URL__ === "string" ? __PLAYER_HOST_URL__ : "",
  typeof __APP_ENV__ === "string" ? __APP_ENV__ : "production",
  Number.parseInt(typeof __PLAYER_LOCAL_PORT__ === "string" ? __PLAYER_LOCAL_PORT__ : "", 10) ||
    5176,
).replace(/\/$/, "")}/oauth-callback`;

/** Hosts explicitly allowed as OAuth redirect_uri for Chromium identity. */
export const EXTENSION_OAUTH_REDIRECT_HOST_SUFFIXES = [
  ".chromiumapp.org",
  ".extensions.allizom.org",
] as const;

/** Firefox intercepts this loopback form for launchWebAuthFlow (Firefox 86+). */
export const FIREFOX_MOZOAUTH2_PREFIX = "http://127.0.0.1/mozoauth2/";

/** Host suffix of the Firefox identity redirect returned by getRedirectURL(). */
export const FIREFOX_ALLIZOM_SUFFIX = ".extensions.allizom.org";

/**
 * Providers differ on which Firefox redirect form they will accept:
 * - google: mozoauth2 loopback (Google accepts loopback redirect URIs).
 * - dropbox: allizom https host. Dropbox only allows `http://` when the host is
 *   literally `localhost`, so the mozoauth2 IP-literal form can never be
 *   registered in the Dropbox App Console.
 */
export type OAuthRedirectProvider = "google" | "dropbox";

export type OAuthRedirectValidation =
  | { ok: true; redirectUri: string; hostname: string }
  | { ok: false; error: string };

/**
 * Firefox identity hash of an addon id (SHA-1 hex).
 * Must match toolkit/components/extensions/child/ext-identity.js `computeHash`.
 */
export function computeFirefoxIdentityHash(extensionId: string): string {
  return sha1Hex(String(extensionId || ""));
}

/**
 * Canonical Firefox OAuth redirect for Google/Dropbox web auth.
 * Example for id `gn-tracing@gnas.dev`:
 *   http://127.0.0.1/mozoauth2/e11893679a6e0e898fdf7bc94c41ea354b335fb7
 */
export function firefoxMozoauth2RedirectUriForAddonId(extensionId: string): string {
  const id = String(extensionId || "").trim();
  if (!id) {
    throw new Error("Firefox addon id is required for mozoauth2 redirect.");
  }
  return `${FIREFOX_MOZOAUTH2_PREFIX}${computeFirefoxIdentityHash(id)}`;
}

/**
 * Canonical Firefox allizom identity redirect for providers that require https.
 * Example for id `gn-tracing@gnas.dev`:
 *   https://e11893679a6e0e898fdf7bc94c41ea354b335fb7.extensions.allizom.org/
 */
export function firefoxAllizomRedirectUriForAddonId(extensionId: string): string {
  const id = String(extensionId || "").trim();
  if (!id) {
    throw new Error("Firefox addon id is required for allizom redirect.");
  }
  return `https://${computeFirefoxIdentityHash(id)}${FIREFOX_ALLIZOM_SUFFIX}/`;
}

/**
 * Extract the Firefox identity subdomain from identity.getRedirectURL().
 * Firefox returns SHA-1(addonId).extensions.allizom.org — not the raw email id.
 */
export function extractFirefoxIdentitySubdomain(identityRedirectUrl: string): string | null {
  const trimmed = String(identityRedirectUrl || "")
    .trim()
    .split("#")[0]
    .split("?")[0];
  const match = trimmed.match(/^https:\/\/(.+?)\.extensions\.allizom\.org(?:\/.*)?$/i);
  if (!match?.[1]) {
    return null;
  }
  const sub = match[1].trim();
  if (!sub || sub.includes("/") || sub.includes("..")) {
    return null;
  }
  return sub;
}

/**
 * Convert a Firefox allizom identity URL into the mozoauth2 loopback form.
 */
export function toFirefoxMozoauth2RedirectUri(identityRedirectUrl: string): string | null {
  const sub = extractFirefoxIdentitySubdomain(identityRedirectUrl);
  if (!sub) {
    return null;
  }
  return `${FIREFOX_MOZOAUTH2_PREFIX}${sub}`;
}

/**
 * Validate Firefox mozoauth2 loopback redirect (http://127.0.0.1/mozoauth2/…).
 */
export function validateFirefoxMozoauth2RedirectUri(raw: string): OAuthRedirectValidation {
  const trimmed = String(raw || "")
    .trim()
    .replace(/\/+$/, "");
  if (!trimmed.startsWith(FIREFOX_MOZOAUTH2_PREFIX)) {
    return {
      ok: false,
      error: "Firefox OAuth redirect must use http://127.0.0.1/mozoauth2/<sha1-hash>.",
    };
  }
  const sub = trimmed.slice(FIREFOX_MOZOAUTH2_PREFIX.length);
  // Firefox uses lowercase hex SHA-1 (40 chars). Accept any non-empty safe path segment.
  if (!sub || sub.includes("/") || sub.includes("..") || sub.includes("?") || sub.includes("#")) {
    return {
      ok: false,
      error: "Firefox mozoauth2 redirect path is invalid.",
    };
  }
  if (sub.includes("@")) {
    return {
      ok: false,
      error:
        "Firefox mozoauth2 path must be SHA-1(addon id), not the raw email-style id. " +
        "Register http://127.0.0.1/mozoauth2/<sha1-hex> from the Manage clouds page.",
    };
  }
  return { ok: true, redirectUri: trimmed, hostname: "127.0.0.1" };
}

/**
 * Validate the Firefox allizom identity redirect (https://<sha1>.extensions.allizom.org/).
 * Unlike validateExtensionOAuthRedirectUri this keeps the allizom form instead of
 * downgrading it to the mozoauth2 loopback — required for Dropbox, which refuses
 * `http://` redirect URIs on anything other than the literal host `localhost`.
 */
export function validateFirefoxAllizomRedirectUri(raw: string): OAuthRedirectValidation {
  const sub = extractFirefoxIdentitySubdomain(raw);
  if (!sub) {
    return {
      ok: false,
      error: `Firefox OAuth redirect must be https://<sha1-hash>${FIREFOX_ALLIZOM_SUFFIX}/.`,
    };
  }
  if (sub.includes("@")) {
    return {
      ok: false,
      error:
        "Firefox allizom subdomain must be SHA-1(addon id), not the raw email-style id. " +
        "Register the URI shown on the Manage clouds page.",
    };
  }
  const hostname = `${sub}${FIREFOX_ALLIZOM_SUFFIX}`.toLowerCase();
  return { ok: true, redirectUri: `https://${hostname}/`, hostname };
}

/**
 * Validate a redirect URI against Google's domain-ownership rules for this
 * extension. Accepts Chromium identity hosts and Firefox mozoauth2 loopback.
 */
export function validateExtensionOAuthRedirectUri(raw: string): OAuthRedirectValidation {
  const trimmed = String(raw || "").trim();
  if (!trimmed) {
    return { ok: false, error: "OAuth redirect URI is empty." };
  }

  if (trimmed.startsWith("http://127.0.0.1/mozoauth2/")) {
    return validateFirefoxMozoauth2RedirectUri(trimmed);
  }

  const mozoFromAllizom = toFirefoxMozoauth2RedirectUri(trimmed);
  if (mozoFromAllizom) {
    return validateFirefoxMozoauth2RedirectUri(mozoFromAllizom);
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
        `(*.chromiumapp.org or Firefox mozoauth2 loopback). Got host: ${hostname}. ` +
        "Do not register arbitrary web domains as redirect URIs " +
        "(Google OAuth domain ownership policy).",
    };
  }

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

function isFirefoxAddonId(id: string): boolean {
  // Email-style (must contain @) or GUID in braces — Firefox gecko id formats.
  return id.includes("@") || (id.startsWith("{") && id.endsWith("}"));
}

/** chrome.runtime.id, or "" when unavailable (tests / non-extension contexts). */
function readRuntimeId(): string {
  try {
    return typeof chrome !== "undefined" && chrome.runtime?.id ? String(chrome.runtime.id) : "";
  } catch {
    return "";
  }
}

/**
 * Canonical redirect for the running extension instance.
 * Safari (macOS + iOS): fixed first-party callback page, no identity API.
 * Firefox: always mozoauth2 with SHA-1(addon id) — same as Firefox identity API.
 * Chromium: chrome.identity.getRedirectURL() (*.chromiumapp.org).
 */
export function resolveRuntimeExtensionRedirectUri(
  target: BrowserTarget = getBrowserTarget(),
): OAuthRedirectValidation {
  if (target === "safari" || target === "safari-ios") {
    return { ok: true, redirectUri: SAFARI_OAUTH_CALLBACK_URL, hostname: "tracing.gnas.dev" };
  }

  const runtimeId = readRuntimeId();

  // Firefox path first — do not use raw email-style id as mozoauth2 path.
  if (runtimeId && isFirefoxAddonId(runtimeId)) {
    return validateFirefoxMozoauth2RedirectUri(firefoxMozoauth2RedirectUriForAddonId(runtimeId));
  }

  try {
    const raw = chrome.identity.getRedirectURL();
    if (raw.includes("extensions.allizom.org")) {
      const mozo = toFirefoxMozoauth2RedirectUri(raw);
      if (mozo) {
        return validateFirefoxMozoauth2RedirectUri(mozo);
      }
    }
  } catch {
    // fall through
  }

  const fromIdentity = resolveValidatedIdentityRedirectUri();
  if (fromIdentity.ok) {
    return fromIdentity;
  }

  if (runtimeId) {
    return validateExtensionOAuthRedirectUri(`https://${runtimeId}.chromiumapp.org/`);
  }
  return fromIdentity;
}

/**
 * Provider-aware redirect for the running extension instance.
 *
 * Chromium is identical for every provider (*.chromiumapp.org). Firefox is not:
 * Google takes the mozoauth2 loopback, while Dropbox rejects any `http://`
 * redirect URI whose host is not literally `localhost` — so an IP literal such
 * as `http://127.0.0.1/mozoauth2/…` cannot even be registered in its App
 * Console. Firefox intercepts the allizom identity host too, and that form is
 * https, so Dropbox gets that one instead.
 */
export function resolveRuntimeExtensionRedirectUriForProvider(
  provider: OAuthRedirectProvider,
  target: BrowserTarget = getBrowserTarget(),
): OAuthRedirectValidation {
  if (provider !== "dropbox" || target === "safari" || target === "safari-ios") {
    return resolveRuntimeExtensionRedirectUri(target);
  }

  const runtimeId = readRuntimeId();
  if (runtimeId && isFirefoxAddonId(runtimeId)) {
    return validateFirefoxAllizomRedirectUri(firefoxAllizomRedirectUriForAddonId(runtimeId));
  }

  try {
    const raw = chrome.identity.getRedirectURL();
    if (raw.includes(FIREFOX_ALLIZOM_SUFFIX)) {
      return validateFirefoxAllizomRedirectUri(raw);
    }
  } catch {
    // fall through to the shared Chromium path
  }

  return resolveRuntimeExtensionRedirectUri();
}

/** Debug fields for Connect UI / support (no secrets). */
export function describeOAuthRedirectDebug(extra: Record<string, string> = {}): string {
  const redirect = resolveRuntimeExtensionRedirectUri();
  const dropboxRedirect = resolveRuntimeExtensionRedirectUriForProvider("dropbox");
  const runtimeId = readRuntimeId() || "(unknown)";
  let identityRaw = "(unavailable)";
  try {
    identityRaw = chrome.identity.getRedirectURL();
  } catch {
    // ignore
  }
  const isFirefox = isFirefoxAddonId(runtimeId);
  const lines = [
    `extensionId(runtime)=${runtimeId}`,
    isFirefox ? `firefoxSha1(id)=${computeFirefoxIdentityHash(runtimeId)}` : "",
    `identity.getRedirectURL()=${identityRaw}`,
    redirect.ok
      ? `redirect_uri(google)=${redirect.redirectUri}`
      : `redirect_uri(google)=(invalid: ${redirect.error})`,
    dropboxRedirect.ok
      ? `redirect_uri(dropbox)=${dropboxRedirect.redirectUri}`
      : `redirect_uri(dropbox)=(invalid: ${dropboxRedirect.error})`,
    redirect.ok && redirect.redirectUri.startsWith(FIREFOX_MOZOAUTH2_PREFIX)
      ? "Firefox: add EXACTLY this redirect_uri on the Web application OAuth client (not Chrome Extension). Never use the raw email id after mozoauth2/."
      : "",
    dropboxRedirect.ok && dropboxRedirect.redirectUri.includes(FIREFOX_ALLIZOM_SUFFIX)
      ? "Firefox: Dropbox needs the https allizom URI above — it refuses http:// redirects on any host other than localhost."
      : "",
    ...Object.entries(extra).map(([k, v]) => `${k}=${v}`),
  ].filter(Boolean);
  return lines.join("\n");
}
