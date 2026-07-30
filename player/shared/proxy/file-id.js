/**
 * Validate public cloud file identifiers before proxying (SSRF / path traversal).
 */

/**
 * Google Drive file ids are typically alphanumeric with `_` and `-`.
 * Reject absolute URLs, path segments, and empty values.
 *
 * @param {string} fileId
 * @returns {{ ok: true; id: string } | { ok: false; error: string }}
 */
export function parseDriveFileId(fileId) {
  const id = String(fileId || "").trim();
  if (!id) {
    return { ok: false, error: "Missing id query parameter" };
  }
  if (/^https?:\/\//i.test(id) || id.includes("://") || id.startsWith("//")) {
    return { ok: false, error: "Drive file id must not be a URL" };
  }
  if (id.includes("/") || id.includes("\\") || id.includes("..")) {
    return { ok: false, error: "Drive file id contains invalid path characters" };
  }
  // Drive ids are URL-safe tokens; keep the charset tight to avoid open-proxy abuse.
  if (!/^[A-Za-z0-9_-]{6,256}$/.test(id)) {
    return { ok: false, error: "Drive file id has an unexpected shape" };
  }
  return { ok: true, id };
}
