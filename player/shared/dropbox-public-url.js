/**
 * Pure Dropbox public shared-link URL helpers for the Player router + Vite proxy.
 *
 * Keep behavior in lockstep with `src/shared/dropbox-api.ts` (unit tests there).
 * Proxies must never fetch arbitrary absolute URLs (open proxy / SSRF).
 */

/** Shared-link path prefixes Dropbox uses for public file links. */
const ALLOWED_SHARED_PATH_PREFIXES = ["s/", "scl/", "sh/", "sm/"];

/**
 * True when host is Dropbox-owned (exact apex or proper subdomain boundary).
 * Rejects spoof hosts like `notdropbox.com`.
 */
export function isDropboxOwnedHost(hostname) {
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
 */
export function isAllowedDropboxSharedLinkPath(pathPart) {
  const path = String(pathPart || "")
    .replace(/^\/+/, "")
    .trim();
  if (!path || path.includes("..")) return false;
  const lower = path.toLowerCase();
  return ALLOWED_SHARED_PATH_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * Builds a public direct-download URL from a canonical Dropbox replay id.
 *
 * Accepts only relative shared-link ids (`s/…`, `scl/…`, `sh/…`, `sm/…` + optional
 * `?rlkey=`). Absolute `http(s)://` ids are rejected to prevent open-proxy SSRF.
 *
 * @param {string} replayId
 * @returns {string}
 */
export function buildDropboxPublicDownloadUrl(replayId) {
  const id = String(replayId || "").trim();
  if (!id) {
    throw new Error("Missing Dropbox replay id");
  }

  // Reject absolute URLs — proxies must not fetch attacker-controlled origins.
  if (/^https?:\/\//i.test(id)) {
    throw new Error("Dropbox replay id must be a relative shared-link path, not an absolute URL");
  }

  // Reject protocol-relative and other schemes.
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
      // Only forward known safe query keys used by Dropbox shared links.
      if (key === "rlkey" || key === "st" || key === "dl") {
        url.searchParams.set(key, value);
      }
    }
  }
  url.searchParams.set("dl", "1");
  return url.toString();
}
