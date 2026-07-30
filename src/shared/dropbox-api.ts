/**
 * Dropbox API helpers for package upload, folder resolve, public share, and
 * canonical replay ids. Used by DropboxProvider and the offscreen uploader so
 * share/upload rules cannot drift between paths.
 *
 * ## Canonical Dropbox replay id
 *
 * Standalone players have **no user token**. After upload we create a public
 * shared link (viewer) and use a **path+query fragment of that shared link**
 * (host stripped) as the replay object id in `/dropbox/<id>`.
 *
 * Example shared URL:
 *   https://www.dropbox.com/scl/fi/abc/file.zip?rlkey=xyz&dl=0
 * Canonical id:
 *   scl/fi/abc/file.zip?rlkey=xyz
 *
 * Proxy/player rebuilds a direct-download URL via `buildDropboxPublicDownloadUrl`.
 * Upload **hard-fails** if share cannot be created (same contract as Drive).
 */

/** Blobs larger than this use Dropbox upload sessions (32 MiB). */
export const DROPBOX_UPLOAD_SESSION_THRESHOLD_BYTES = 32 * 1024 * 1024;
/** Dropbox content upload session chunk size. */
export const DROPBOX_UPLOAD_SESSION_CHUNK_BYTES = 8 * 1024 * 1024;

const DROPBOX_API = "https://api.dropboxapi.com/2";
const DROPBOX_CONTENT = "https://content.dropboxapi.com/2";

export interface DropboxUploadProgress {
  loadedBytes: number;
  totalBytes: number;
}

/** Shared-link path prefixes Dropbox uses for public file links. */
const ALLOWED_SHARED_PATH_PREFIXES = ["s/", "scl/", "sh/", "sm/"] as const;

/**
 * True when host is Dropbox-owned (exact apex or proper subdomain boundary).
 * Rejects spoof hosts like `notdropbox.com`.
 * Keep in sync with `player/shared/dropbox-public-url.js`.
 */
export function isDropboxOwnedHost(hostname: string): boolean {
  const host = String(hostname || "")
    .trim()
    .toLowerCase();
  if (!host) return false;
  if (host === "db.tt") return true;
  if (host === "dropbox.com" || host.endsWith(".dropbox.com")) return true;
  if (host === "dropboxusercontent.com" || host.endsWith(".dropboxusercontent.com")) return true;
  return false;
}

/**
 * True when path (no leading slash) is a known Dropbox shared-link shape.
 * Keep in sync with `player/shared/dropbox-public-url.js`.
 */
export function isAllowedDropboxSharedLinkPath(pathPart: string): boolean {
  const path = String(pathPart || "")
    .replace(/^\/+/, "")
    .trim();
  if (!path || path.includes("..")) return false;
  const lower = path.toLowerCase();
  return ALLOWED_SHARED_PATH_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * Converts a Dropbox shared-link URL into the canonical replay id stored in
 * `/dropbox/<id>` (path + essential query, no host, no dl=).
 */
export function encodeDropboxReplayIdFromSharedUrl(sharedUrl: string): string {
  const trimmed = String(sharedUrl || "").trim();
  if (!trimmed) {
    throw new Error("Dropbox shared link URL is empty");
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Dropbox shared link URL is invalid");
  }

  if (!isDropboxOwnedHost(url.hostname)) {
    throw new Error(`Unexpected Dropbox shared link host: ${url.hostname}`);
  }

  // Prefer path after first slash; keep rlkey (required for new scl links).
  const path = url.pathname.replace(/^\/+/, "");
  if (!path) {
    throw new Error("Dropbox shared link has no path");
  }
  if (!isAllowedDropboxSharedLinkPath(path)) {
    throw new Error(`Dropbox shared link path is not a known shared-link shape: ${path}`);
  }

  const rlkey = url.searchParams.get("rlkey");
  if (rlkey) {
    return `${path}?rlkey=${encodeURIComponent(rlkey)}`;
  }
  return path;
}

/**
 * Rebuilds a public direct-download URL from a canonical Dropbox replay id.
 * Uses www.dropbox.com with dl=1 so Dropbox redirects to content bytes.
 *
 * Absolute `http(s)://` ids are rejected (open-proxy / SSRF prevention for
 * proxies that call this). Keep in sync with player shared module.
 */
export function buildDropboxPublicDownloadUrl(replayId: string): string {
  const id = String(replayId || "").trim();
  if (!id) {
    throw new Error("Missing Dropbox replay id");
  }

  // Reject absolute URLs — never pass through user-controlled origins.
  if (/^https?:\/\//i.test(id)) {
    throw new Error("Dropbox replay id must be a relative shared-link path, not an absolute URL");
  }
  if (id.includes("://") || id.startsWith("//")) {
    throw new Error("Dropbox replay id contains an unexpected scheme");
  }

  const qIndex = id.indexOf("?");
  const pathPart = (qIndex >= 0 ? id.slice(0, qIndex) : id).replace(/^\/+/, "");
  const queryPart = qIndex >= 0 ? id.slice(qIndex + 1) : "";

  if (!isAllowedDropboxSharedLinkPath(pathPart)) {
    throw new Error(
      "Dropbox replay id path must start with a shared-link prefix (s/, scl/, sh/, or sm/)",
    );
  }

  const url = new URL(`https://www.dropbox.com/${pathPart}`);
  if (queryPart) {
    const params = new URLSearchParams(queryPart);
    for (const [key, value] of params) {
      if (key === "rlkey" || key === "st" || key === "dl") {
        url.searchParams.set(key, value);
      }
    }
  }
  url.searchParams.set("dl", "1");
  return url.toString();
}

/** Rebuilds the shared-link URL (dl=0) from a canonical replay id for API calls. */
export function buildDropboxSharedLinkUrl(replayId: string): string {
  const downloadUrl = buildDropboxPublicDownloadUrl(replayId);
  const url = new URL(downloadUrl);
  url.searchParams.set("dl", "0");
  return url.toString();
}

/**
 * Encodes a JSON object for the Dropbox-API-Arg HTTP header.
 * Non-ASCII characters must be `\uXXXX`-escaped so the header stays ASCII.
 * @see https://www.dropbox.com/developers/reference/json-encoding
 */
export function encodeDropboxApiArg(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (char) => {
    const hex = char.charCodeAt(0).toString(16).padStart(4, "0");
    return `\\u${hex}`;
  });
}

interface DropboxErrorBody {
  error_summary?: string;
  error?:
    | string
    | {
        ".tag"?: string;
        path?: { ".tag"?: string; conflict?: { ".tag"?: string } };
      };
  user_message?: { text?: string };
}

async function readDropboxErrorBody(
  response: Response,
): Promise<{ summary: string; body: DropboxErrorBody | null }> {
  try {
    const body = (await response.json()) as DropboxErrorBody;
    if (typeof body.error_summary === "string" && body.error_summary) {
      return { summary: body.error_summary, body };
    }
    if (typeof body.user_message?.text === "string" && body.user_message.text) {
      return { summary: body.user_message.text, body };
    }
    if (typeof body.error === "string") {
      return { summary: body.error, body };
    }
    return { summary: `HTTP ${response.status}`, body };
  } catch {
    return { summary: `HTTP ${response.status}`, body: null };
  }
}

async function readDropboxError(response: Response): Promise<string> {
  return (await readDropboxErrorBody(response)).summary;
}

/**
 * True when create_folder failed because a folder already exists at the path.
 * Only `path/conflict/folder` is success-on-exists; `path/conflict/file` fails.
 */
export function isDropboxFolderAlreadyExistsError(
  summary: string,
  body?: DropboxErrorBody | null,
): boolean {
  const text = String(summary || "");
  if (text.includes("path/conflict/folder")) {
    return true;
  }
  // Structured tag: error.path.conflict[".tag"] === "folder"
  const conflictTag =
    body && typeof body.error === "object" && body.error
      ? body.error.path?.conflict?.[".tag"]
      : undefined;
  if (conflictTag === "folder") {
    return true;
  }
  return false;
}

/**
 * Ensures each path segment exists as a folder under the previous parent.
 * Returns the absolute Dropbox path for the final folder ("" for root).
 */
export async function resolveDropboxFolderPath(
  authToken: string,
  folderPath: string[] | undefined,
): Promise<string | null> {
  const segments = Array.isArray(folderPath)
    ? folderPath.filter((segment) => typeof segment === "string" && segment.trim())
    : [];

  if (segments.length === 0) {
    return null;
  }

  let current = "";
  for (const raw of segments) {
    const segment = raw.trim();
    current = `${current}/${segment}`;
    await ensureDropboxFolder(authToken, current);
  }
  return current;
}

async function ensureDropboxFolder(authToken: string, path: string): Promise<void> {
  const response = await fetch(`${DROPBOX_API}/files/create_folder_v2`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ path, autorename: false }),
  });

  if (response.ok) {
    return;
  }

  const { summary, body } = await readDropboxErrorBody(response);
  // Only treat folder-already-exists as success. path/conflict/file and other
  // errors must hard-fail so upload does not silently use a missing parent.
  if (isDropboxFolderAlreadyExistsError(summary, body)) {
    return;
  }
  throw new Error(`Dropbox create folder failed: ${summary}`);
}

/**
 * Uploads a file to Dropbox. Returns the absolute path of the created file
 * (used as the temporary file id before sharing).
 */
export async function uploadDropboxFile(args: {
  authToken: string;
  /** Absolute Dropbox path including filename, e.g. /gn-tracing/file.zip */
  path: string;
  blob: Blob;
  sessionThresholdBytes?: number;
  onProgress?: (progress: DropboxUploadProgress) => void;
}): Promise<{ path: string; id: string }> {
  const threshold = args.sessionThresholdBytes ?? DROPBOX_UPLOAD_SESSION_THRESHOLD_BYTES;
  if (args.blob.size > threshold) {
    return uploadDropboxFileSession(args);
  }
  return uploadDropboxFileSimple(args);
}

async function uploadDropboxFileSimple(args: {
  authToken: string;
  path: string;
  blob: Blob;
  onProgress?: (progress: DropboxUploadProgress) => void;
}): Promise<{ path: string; id: string }> {
  const apiArg = encodeDropboxApiArg({
    path: args.path,
    mode: "add",
    autorename: true,
    mute: false,
    strict_conflict: false,
  });

  const result = await new Promise<{ path_display?: string; path_lower?: string; id?: string }>(
    (resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${DROPBOX_CONTENT}/files/upload`);
      xhr.setRequestHeader("Authorization", `Bearer ${args.authToken}`);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.setRequestHeader("Dropbox-API-Arg", apiArg);
      xhr.upload.addEventListener("progress", (event) => {
        const loaded =
          event.lengthComputable && event.total > 0
            ? Math.min(args.blob.size, Math.round((event.loaded / event.total) * args.blob.size))
            : Math.min(event.loaded, args.blob.size);
        args.onProgress?.({ loadedBytes: loaded, totalBytes: args.blob.size });
      });
      xhr.onerror = () => reject(new Error("Dropbox upload failed due to a network error"));
      xhr.onload = () => {
        let payload: {
          path_display?: string;
          path_lower?: string;
          id?: string;
          error_summary?: string;
        } = {};
        try {
          payload = xhr.responseText ? JSON.parse(xhr.responseText) : {};
        } catch {
          // ignore
        }
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(
            new Error(payload.error_summary || `Dropbox upload failed with status ${xhr.status}`),
          );
          return;
        }
        resolve(payload);
      };
      xhr.send(args.blob);
    },
  );

  args.onProgress?.({ loadedBytes: args.blob.size, totalBytes: args.blob.size });
  const path = result.path_display || result.path_lower || args.path;
  const id = result.id || path;
  return { path, id };
}

async function uploadDropboxFileSession(args: {
  authToken: string;
  path: string;
  blob: Blob;
  onProgress?: (progress: DropboxUploadProgress) => void;
}): Promise<{ path: string; id: string }> {
  const total = args.blob.size;
  let offset = 0;
  let sessionId: string | null = null;

  // Start
  {
    const chunk = args.blob.slice(0, Math.min(DROPBOX_UPLOAD_SESSION_CHUNK_BYTES, total));
    const startResponse = await fetch(`${DROPBOX_CONTENT}/files/upload_session/start`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.authToken}`,
        "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": encodeDropboxApiArg({ close: false }),
      },
      body: chunk,
    });
    if (!startResponse.ok) {
      throw new Error(
        `Dropbox upload session start failed: ${await readDropboxError(startResponse)}`,
      );
    }
    const startPayload = (await startResponse.json()) as { session_id?: string };
    if (!startPayload.session_id) {
      throw new Error("Dropbox upload session start did not return session_id");
    }
    sessionId = startPayload.session_id;
    offset = chunk.size;
    args.onProgress?.({ loadedBytes: offset, totalBytes: total });
  }

  // Append
  while (offset + DROPBOX_UPLOAD_SESSION_CHUNK_BYTES < total) {
    const chunk = args.blob.slice(offset, offset + DROPBOX_UPLOAD_SESSION_CHUNK_BYTES);
    const appendResponse = await fetch(`${DROPBOX_CONTENT}/files/upload_session/append_v2`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.authToken}`,
        "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": encodeDropboxApiArg({
          cursor: { session_id: sessionId, offset },
          close: false,
        }),
      },
      body: chunk,
    });
    if (!appendResponse.ok) {
      throw new Error(
        `Dropbox upload session append failed: ${await readDropboxError(appendResponse)}`,
      );
    }
    offset += chunk.size;
    args.onProgress?.({ loadedBytes: offset, totalBytes: total });
  }

  // Finish
  const finalChunk = args.blob.slice(offset);
  const finishResponse = await fetch(`${DROPBOX_CONTENT}/files/upload_session/finish`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.authToken}`,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": encodeDropboxApiArg({
        cursor: { session_id: sessionId, offset },
        commit: {
          path: args.path,
          mode: "add",
          autorename: true,
          mute: false,
          strict_conflict: false,
        },
      }),
    },
    body: finalChunk,
  });

  if (!finishResponse.ok) {
    throw new Error(
      `Dropbox upload session finish failed: ${await readDropboxError(finishResponse)}`,
    );
  }

  const finishPayload = (await finishResponse.json()) as {
    path_display?: string;
    path_lower?: string;
    id?: string;
  };
  args.onProgress?.({ loadedBytes: total, totalBytes: total });
  const path = finishPayload.path_display || finishPayload.path_lower || args.path;
  const id = finishPayload.id || path;
  return { path, id };
}

/**
 * Creates a public viewer shared link for the file at `path` and returns the
 * canonical replay id. Hard-fails when sharing is not possible.
 */
export async function makeDropboxPublicReadable(
  authToken: string,
  path: string,
): Promise<{ replayId: string; sharedUrl: string }> {
  const sharedUrl = await createOrGetSharedLink(authToken, path);
  const replayId = encodeDropboxReplayIdFromSharedUrl(sharedUrl);
  return { replayId, sharedUrl };
}

async function createOrGetSharedLink(authToken: string, path: string): Promise<string> {
  const createResponse = await fetch(`${DROPBOX_API}/sharing/create_shared_link_with_settings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      path,
      settings: {
        requested_visibility: "public",
        audience: "public",
        access: "viewer",
      },
    }),
  });

  if (createResponse.ok) {
    const payload = (await createResponse.json()) as { url?: string };
    if (typeof payload.url === "string" && payload.url) {
      return payload.url;
    }
    throw new Error("Dropbox create_shared_link did not return a URL");
  }

  const detail = await readDropboxError(createResponse);
  // Link already exists — list it.
  if (
    detail.includes("shared_link_already_exists") ||
    detail.includes("already exists") ||
    createResponse.status === 409
  ) {
    const listResponse = await fetch(`${DROPBOX_API}/sharing/list_shared_links`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path, direct_only: true }),
    });
    if (!listResponse.ok) {
      throw new Error(`Dropbox list_shared_links failed: ${await readDropboxError(listResponse)}`);
    }
    const listPayload = (await listResponse.json()) as { links?: Array<{ url?: string }> };
    const url = listPayload.links?.find((link) => typeof link.url === "string")?.url;
    if (url) {
      return url;
    }
    throw new Error("Dropbox reported an existing shared link but none was returned");
  }

  throw new Error(`Dropbox share failed: ${detail}`);
}
