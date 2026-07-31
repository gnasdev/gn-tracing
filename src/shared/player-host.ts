/**
 * Chooses the **external** replay player host (hosted player).
 * The extension does not ship player UI; all open/history links use this host.
 *
 * Host is baked at build time from env (see `esbuild.config.mjs`):
 * - development / watch → `PLAYER_HOST_URL_DEV` or `http://localhost:$PLAYER_LOCAL_PORT/`
 * - production → `PLAYER_HOST_URL` or `https://tracing.gnas.dev/`
 *
 * Instant Replay and screenshot reports call `buildExternalPlayerUrl` after
 * upload; opening history uses `resolveReplayOpenUrl`, which rewrites production
 * hosts to the local player when the extension is a development build.
 */
import { getProductVersion } from "./app-version";
import { buildStorageRecordingPath, type StorageProviderId } from "./storage-provider";

declare const __APP_ENV__: string;
declare const __PLAYER_LOCAL_PORT__: string;
declare const __PLAYER_HOST_URL__: string;

/**
 * Centralized player URL builder.
 *
 * New uploads emit versioned namespaced paths (`/{version}/gdrive/<id>`,
 * `/{version}/dropbox/<id>`). Legacy unversioned and bare Drive ids remain
 * parseable by `parseStorageRecordingRef`.
 */
const APP_ENV = normalizeAppEnv(typeof __APP_ENV__ === "string" ? __APP_ENV__ : "production");
const PLAYER_LOCAL_PORT = Number.parseInt(__PLAYER_LOCAL_PORT__ || "5176", 10) || 5176;
const IS_DEVELOPMENT = APP_ENV === "development";
const PRODUCTION_PLAYER_HOST_URL = "https://tracing.gnas.dev/";

const PLAYER_HOST_URL = resolvePlayerHostUrl(
  typeof __PLAYER_HOST_URL__ === "string" ? __PLAYER_HOST_URL__ : "",
  APP_ENV,
  PLAYER_LOCAL_PORT,
);

/** Exported for tests and diagnostics. */
export function getPlayerHostUrl(): string {
  return PLAYER_HOST_URL;
}

/** Known production player origins (custom domain + Pages default). */
export const PRODUCTION_PLAYER_ORIGINS = [
  "https://tracing.gnas.dev",
  "http://tracing.gnas.dev",
  "https://gn-tracing-player.pages.dev",
  "http://gn-tracing-player.pages.dev",
] as const;

/** Exported for tests. */
export function resolvePlayerHostUrl(
  configuredHost: string,
  appEnv: string,
  localPort: number = 5176,
): string {
  const isDev = normalizeAppEnv(appEnv) === "development";
  const localHost = `http://localhost:${localPort || 5176}/`;
  const configured = ensureTrailingSlash(String(configuredHost || "").trim());
  if (configured) {
    // Development builds must never emit the production player host, even when
    // PLAYER_HOST_URL_DEV is mis-set to tracing.gnas.dev (common when copying
    // .env from production). Preview/custom hosts still win.
    if (isDev && isProductionPlayerOrigin(configured)) {
      return localHost;
    }
    return configured;
  }
  if (isDev) {
    return localHost;
  }
  return PRODUCTION_PLAYER_HOST_URL;
}

/** True when the URL's origin is a known production player host. */
export function isProductionPlayerOrigin(urlOrHost: string): boolean {
  const raw = String(urlOrHost || "").trim();
  if (!raw) {
    return false;
  }
  try {
    const parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return (PRODUCTION_PLAYER_ORIGINS as readonly string[]).includes(parsed.origin);
  } catch {
    return false;
  }
}

/**
 * Builds a full external replay URL for a recording package file id.
 *
 * @param recordingId - Cloud file / object id returned after upload.
 * @param provider - Active storage provider; defaults to google-drive.
 *   New uploads use `/{productVersion}/gdrive|dropbox/<id>`.
 */
export function buildExternalPlayerUrl(
  recordingId: string,
  provider: StorageProviderId = "google-drive",
): string {
  const baseUrl = PLAYER_HOST_URL.replace(/\/$/, "");
  // Always emit product-version-prefixed paths when a recording id is present.
  // getProductVersion() throws if the build define is missing/invalid.
  const path = buildStorageRecordingPath(recordingId, provider, getProductVersion());
  if (!path) {
    return `${baseUrl}/`;
  }
  return `${baseUrl}${path}`;
}

/**
 * Resolves a URL for **opening** a replay from the extension UI.
 *
 * In development builds, rewrites production player origins
 * (`https://tracing.gnas.dev`) to the local player host so Instant Replay and
 * history links exercise the dev player (with the still stage, etc.).
 */
export function resolveReplayOpenUrl(recordingUrl: string): string {
  const raw = String(recordingUrl || "").trim();
  if (!raw) {
    return "";
  }
  if (!IS_DEVELOPMENT) {
    return raw;
  }
  return rewritePlayerHostForDevelopment(raw, PLAYER_HOST_URL);
}

/**
 * Pure rewrite helper (unit-tested). Maps known production player origins onto
 * the development player host while preserving path/query/hash.
 */
export function rewritePlayerHostForDevelopment(
  recordingUrl: string,
  developmentHost: string,
): string {
  const raw = String(recordingUrl || "").trim();
  if (!raw) {
    return "";
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return raw;
  }

  if (!(PRODUCTION_PLAYER_ORIGINS as readonly string[]).includes(parsed.origin)) {
    return raw;
  }

  let local: URL;
  try {
    local = new URL(ensureTrailingSlash(developmentHost));
  } catch {
    return raw;
  }

  parsed.protocol = local.protocol;
  parsed.host = local.host;
  return parsed.toString();
}

function ensureTrailingSlash(value: string): string {
  if (!value) {
    return value;
  }
  return value.endsWith("/") ? value : `${value}/`;
}

function normalizeAppEnv(value: string): string {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "dev") return "development";
  if (normalized === "prod") return "production";
  return normalized || "production";
}
