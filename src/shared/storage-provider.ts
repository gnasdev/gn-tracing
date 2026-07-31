/**
 * Multi-cloud storage provider ids and replay URL helpers.
 *
 * Replay URLs are namespaced by provider so the player can route downloads:
 *   https://tracing.gnas.dev/gdrive/<id>
 *   https://tracing.gnas.dev/dropbox/<id>
 *
 * New uploads also prefix the product (extension) version:
 *   https://tracing.gnas.dev/1.7.5/gdrive/<id>
 *
 * Legacy Google Drive bare-id URLs remain parseable forever:
 *   https://tracing.gnas.dev/<drive-file-id>
 *
 * Legacy `/onedrive/…` path segments are recognized only so the player can
 * fail closed without calling Microsoft hosts (OneDrive support removed).
 *
 * The standalone/extension player reimplements the same parse rules in
 * `player/public/player.js` (`resolveReplayRecordingRef`) — update both when changing
 * URL semantics. Package consumers use `packages/replay-core` recording-ref.
 */

import { isProductRouteVersion, joinVersionedPath, stripRouteVersionPrefix } from "./route-version";

export type StorageProviderId = "google-drive" | "dropbox";

/** Providers that can connect/upload in this build. */
export const STORAGE_PROVIDER_IDS = ["google-drive", "dropbox"] as const;

/** URL path segment for each active provider (first path segment after host). */
export const STORAGE_PROVIDER_PATH_SEGMENTS: Record<StorageProviderId, string> = {
  "google-drive": "gdrive",
  dropbox: "dropbox",
};

const PATH_SEGMENT_TO_PROVIDER: Record<string, StorageProviderId | "removed-onedrive"> = {
  gdrive: "google-drive",
  dropbox: "dropbox",
  // Historical namespace — not a connectable provider.
  onedrive: "removed-onedrive",
};

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
 * Builds the path portion of a replay URL for a provider + file id.
 * Google Drive always uses the namespaced `/gdrive/<id>` form for new uploads.
 *
 * When `productVersion` is provided it must be a core semver string and the
 * path is prefixed (`/1.7.5/gdrive/<id>`). Invalid versions throw — callers
 * that need a bare legacy path must omit the argument entirely.
 */
export function buildStorageRecordingPath(
  fileId: string,
  provider: StorageProviderId = "google-drive",
  productVersion?: string,
): string {
  const id = String(fileId || "").trim();
  if (!id) {
    return "";
  }
  const segment = STORAGE_PROVIDER_PATH_SEGMENTS[provider];
  const base = `/${segment}/${encodeURIComponent(id)}`;
  const version = String(productVersion ?? "").trim();
  if (!version) {
    return base;
  }
  return joinVersionedPath(version, base);
}

/**
 * Parses a replay URL, pathname, or bare file id into provider + file id.
 *
 * Rules (in order):
 * 1. Query `?id=` (+ optional `?provider=`) — default provider google-drive.
 *    Unknown providers (including onedrive) fall back to google-drive only when
 *    using bare `?id=`; namespaced `/onedrive/` paths return null (fail closed).
 * 2. First path segment `gdrive`/`dropbox` → that provider + rest as id.
 * 3. First path segment `onedrive` → null (removed; do not call Microsoft).
 * 4. Otherwise → google-drive + bare id (legacy).
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

  // Bare file id (no slashes, not a full URL) → legacy google-drive.
  if (!raw.includes("://") && !raw.startsWith("/") && !raw.includes("?")) {
    const bareId = safeDecode(raw);
    if (!bareId || bareId.includes(".")) {
      return null;
    }
    return { provider: "google-drive", fileId: bareId };
  }

  let url: URL;
  try {
    url = typeof input === "string" ? new URL(raw, "https://tracing.gnas.dev") : input;
  } catch {
    return null;
  }

  const queryId = url.searchParams.get("id")?.trim();
  if (queryId) {
    const providerParam = url.searchParams.get("provider");
    // Explicit onedrive query → fail closed (removed).
    if (typeof providerParam === "string" && providerParam.trim().toLowerCase() === "onedrive") {
      return null;
    }
    const provider = normalizeStorageProviderId(providerParam, "google-drive");
    return { provider, fileId: safeDecode(queryId) };
  }

  const { remainder } = stripRouteVersionPrefix(url.pathname);
  const segments = remainder
    .split("/")
    .map((segment: string) => segment.trim())
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
    if (!fileId) {
      return null;
    }
    return { provider: namespacedProvider, fileId };
  }

  // Legacy bare path: first non-reserved segment is the Drive file id.
  // A lone product-version segment (no provider) is not a recording ref.
  const reserved = new Set(["app", "privacy", "terms", "icons", "assets", "vendor", "api"]);
  if (
    reserved.has(first) ||
    first.endsWith(".html") ||
    first.includes(".") ||
    isProductRouteVersion(segments[0])
  ) {
    return null;
  }

  return { provider: "google-drive", fileId: safeDecode(segments[0]) };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Infers the storage provider for a history/session row when the explicit
 * provider field is missing (legacy entries).
 */
export function resolveHistoryProvider(
  provider: unknown,
  recordingUrl: string | null | undefined,
): StorageProviderId {
  if (isStorageProviderId(provider)) {
    return provider;
  }
  const ref = parseStorageRecordingRef(recordingUrl);
  return ref?.provider ?? "google-drive";
}

/**
 * Builds a browser URL that opens the **uploaded package** (preferred) or its
 * containing folder in the cloud provider's website.
 *
 * Used by popup + upload-history "Open remote" actions.
 *
 * Google Drive:
 *   - file:  https://drive.google.com/file/d/<fileId>/view
 *   - folder: https://drive.google.com/drive/folders/<folderId>
 * Dropbox:
 *   - file:  public shared-link view (dl=0) rebuilt from the replay id
 *   - folder: https://www.dropbox.com/home/<path>
 */
export function buildCloudRemoteOpenUrl(args: {
  provider?: StorageProviderId | string | null;
  recordingUrl?: string | null;
  /** Drive folder id, or Dropbox absolute folder path (`/gn-tracing`). */
  folderRef?: string | null;
  /** Optional explicit package id (Drive file id or Dropbox shared-link id). */
  fileId?: string | null;
}): string | null {
  const recordingRef = parseStorageRecordingRef(args.recordingUrl);
  const provider = resolveHistoryProvider(
    args.provider ?? recordingRef?.provider,
    args.recordingUrl,
  );
  const fileId = String(args.fileId || recordingRef?.fileId || "").trim();
  const folderRef = String(args.folderRef ?? "").trim();

  if (provider === "dropbox") {
    const fileUrl = buildDropboxRemoteFileUrl(fileId);
    if (fileUrl) {
      return fileUrl;
    }
    return buildDropboxRemoteFolderUrl(folderRef);
  }

  // google-drive
  const driveFileUrl = buildGoogleDriveRemoteFileUrl(fileId);
  if (driveFileUrl) {
    return driveFileUrl;
  }
  return buildGoogleDriveRemoteFolderUrl(folderRef);
}

/** @deprecated Prefer buildCloudRemoteOpenUrl — kept for callers that only have a folder ref. */
export function buildCloudFolderOpenUrl(
  provider: StorageProviderId | string | null | undefined,
  folderRef: string | null | undefined,
): string | null {
  return buildCloudRemoteOpenUrl({ provider, folderRef });
}

function buildGoogleDriveRemoteFileUrl(fileId: string): string | null {
  if (!fileId || fileId.includes("/") || fileId.includes("?") || /^https?:\/\//i.test(fileId)) {
    return null;
  }
  // Drive file ids are typically 10+ alphanumeric/_/- characters.
  if (!/^[a-zA-Z0-9_-]{6,}$/.test(fileId)) {
    return null;
  }
  return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`;
}

function buildGoogleDriveRemoteFolderUrl(folderRef: string): string | null {
  if (!folderRef || folderRef === "/" || /^https?:\/\//i.test(folderRef)) {
    return null;
  }
  // Slash paths are Dropbox-style, not Drive folder ids.
  if (folderRef.includes("/")) {
    return null;
  }
  if (!/^[a-zA-Z0-9_-]{6,}$/.test(folderRef)) {
    return null;
  }
  return `https://drive.google.com/drive/folders/${encodeURIComponent(folderRef)}`;
}

function buildDropboxRemoteFileUrl(replayId: string): string | null {
  if (!replayId || /^https?:\/\//i.test(replayId) || replayId.includes("://")) {
    return null;
  }
  const qIndex = replayId.indexOf("?");
  const pathPart = (qIndex >= 0 ? replayId.slice(0, qIndex) : replayId).replace(/^\/+/, "");
  const queryPart = qIndex >= 0 ? replayId.slice(qIndex + 1) : "";
  const lower = pathPart.toLowerCase();
  const allowed = ["s/", "scl/", "sh/", "sm/"].some((prefix) => lower.startsWith(prefix));
  if (!pathPart || pathPart.includes("..") || !allowed) {
    return null;
  }
  try {
    const url = new URL(`https://www.dropbox.com/${pathPart}`);
    if (queryPart) {
      const params = new URLSearchParams(queryPart);
      for (const [key, value] of params) {
        if (key === "rlkey" || key === "st" || key === "dl") {
          url.searchParams.set(key, value);
        }
      }
    }
    // Browser view of the shared package (not force-download).
    url.searchParams.set("dl", "0");
    return url.toString();
  } catch {
    return null;
  }
}

function buildDropboxRemoteFolderUrl(folderRef: string): string | null {
  // Accept `/gn-tracing`, `gn-tracing`, or empty (account home).
  if (/^https?:\/\//i.test(folderRef) || folderRef.includes("://")) {
    return null;
  }
  const path = folderRef.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!path) {
    return "https://www.dropbox.com/home";
  }
  if (path.includes("..")) {
    return null;
  }
  const encoded = path
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `https://www.dropbox.com/home/${encoded}`;
}
