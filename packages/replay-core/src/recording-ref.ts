/**
 * Replay URL parsing shared by every non-browser consumer of a recording.
 *
 * The extension owns the canonical implementation in
 * `src/shared/storage-provider.ts` and the player reimplements it in
 * `player/player.js` (`resolveReplayRecordingRef`). This module is the third
 * copy's replacement: a pure, dependency-free version that MCP transports use,
 * kept behaviourally identical by the golden test in `recording-ref.test.ts`.
 *
 * Replay URLs are namespaced by provider:
 *   https://tracing.gnas.dev/gdrive/<file-id>
 *   https://tracing.gnas.dev/dropbox/<shared-link-id>
 * Legacy Google Drive bare-id URLs stay parseable; `/onedrive/...` fails closed.
 */

export type StorageProviderId = "google-drive" | "dropbox";

export const STORAGE_PROVIDER_IDS = ["google-drive", "dropbox"] as const;

export const STORAGE_PROVIDER_PATH_SEGMENTS: Record<StorageProviderId, string> = {
  "google-drive": "gdrive",
  dropbox: "dropbox",
};

const PATH_SEGMENT_TO_PROVIDER: Record<string, StorageProviderId | "removed-onedrive"> = {
  gdrive: "google-drive",
  dropbox: "dropbox",
  onedrive: "removed-onedrive",
};

/** Path segments the hosted player owns; never a legacy bare Drive file id. */
const RESERVED_FIRST_SEGMENTS = new Set([
  "app",
  "privacy",
  "terms",
  "icons",
  "assets",
  "vendor",
  "api",
]);

/** Default origin of the hosted replay player. */
export const DEFAULT_PLAYER_ORIGIN = "https://tracing.gnas.dev";

/** Same-origin download proxy path per provider (see `player-standalone/functions/api`). */
const PROVIDER_PROXY_PATHS: Record<StorageProviderId, string> = {
  "google-drive": "/api/drive",
  dropbox: "/api/dropbox",
};

/** Dropbox shared-link id prefixes the proxy accepts (SSRF allowlist). */
const DROPBOX_ID_PREFIXES = ["s/", "scl/", "sh/", "sm/"];

export interface StorageRecordingRef {
  provider: StorageProviderId;
  fileId: string;
}

export function isStorageProviderId(value: unknown): value is StorageProviderId {
  return typeof value === "string" && (STORAGE_PROVIDER_IDS as readonly string[]).includes(value);
}

export function normalizeStorageProviderId(
  value: unknown,
  fallback: StorageProviderId = "google-drive",
): StorageProviderId {
  return isStorageProviderId(value) ? value : fallback;
}

/**
 * Parses a replay URL, pathname, or bare file id into provider + file id.
 * Returns null for anything that is not a replay reference (fail closed).
 */
export function parseStorageRecordingRef(
  input: string | URL | null | undefined,
): StorageRecordingRef | null {
  if (input == null) {
    return null;
  }

  const raw = typeof input === "string" ? input.trim() : input.toString();
  if (!raw) {
    return null;
  }

  if (!raw.includes("://") && !raw.startsWith("/") && !raw.includes("?")) {
    const bareId = safeDecode(raw);
    if (!bareId || bareId.includes(".")) {
      return null;
    }
    return { provider: "google-drive", fileId: bareId };
  }

  let url: URL;
  try {
    url = typeof input === "string" ? new URL(raw, DEFAULT_PLAYER_ORIGIN) : input;
  } catch {
    return null;
  }

  const queryId = url.searchParams.get("id")?.trim();
  if (queryId) {
    const providerParam = url.searchParams.get("provider");
    if (typeof providerParam === "string" && providerParam.trim().toLowerCase() === "onedrive") {
      return null;
    }
    return {
      provider: normalizeStorageProviderId(providerParam, "google-drive"),
      fileId: safeDecode(queryId),
    };
  }

  const segments = url.pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length === 0) {
    return null;
  }

  const first = segments[0].toLowerCase();
  const namespacedProvider = PATH_SEGMENT_TO_PROVIDER[first];
  if (namespacedProvider === "removed-onedrive") {
    return null;
  }
  if (namespacedProvider) {
    if (segments.length < 2) {
      return null;
    }
    const fileId = safeDecode(segments.slice(1).join("/"));
    return fileId ? { provider: namespacedProvider, fileId } : null;
  }

  if (RESERVED_FIRST_SEGMENTS.has(first) || first.endsWith(".html") || first.includes(".")) {
    return null;
  }

  return { provider: "google-drive", fileId: safeDecode(segments[0]) };
}

/** Builds the replay URL a human opens for a ref. */
export function buildReplayUrl(ref: StorageRecordingRef, origin = DEFAULT_PLAYER_ORIGIN): string {
  const segment = STORAGE_PROVIDER_PATH_SEGMENTS[ref.provider];
  return `${trimTrailingSlash(origin)}/${segment}/${encodeURIComponent(ref.fileId)}`;
}

/**
 * Builds the same-origin proxy URL that streams the recording **package bytes**.
 * Both proxies accept `?id=` and forward `Range`, which is what the zip reader
 * relies on to avoid downloading the video parts.
 */
export function buildPackageDownloadUrl(
  ref: StorageRecordingRef,
  origin = DEFAULT_PLAYER_ORIGIN,
): string {
  const path = PROVIDER_PROXY_PATHS[ref.provider];
  return `${trimTrailingSlash(origin)}${path}?id=${encodeURIComponent(ref.fileId)}`;
}

/**
 * Rejects ids the download proxies would refuse anyway, so remote transports
 * fail before making an upstream request.
 *
 * Google Drive: opaque id characters only.
 * Dropbox: relative shared-link path only — absolute URLs are an SSRF vector.
 */
export function isSupportedRecordingRef(ref: StorageRecordingRef): boolean {
  const fileId = ref.fileId.trim();
  if (!fileId || fileId.includes("..") || /^https?:\/\//i.test(fileId) || fileId.includes("://")) {
    return false;
  }

  if (ref.provider === "dropbox") {
    const pathPart = fileId.split("?")[0].replace(/^\/+/, "").toLowerCase();
    return DROPBOX_ID_PREFIXES.some((prefix) => pathPart.startsWith(prefix));
  }

  return /^[a-zA-Z0-9_-]{6,}$/.test(fileId);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
