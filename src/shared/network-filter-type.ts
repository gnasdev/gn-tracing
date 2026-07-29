/**
 * DevTools-like network resource filter classification for the replay player.
 *
 * Pure: no DOM. Production callers: player (via `window.gnCore.network`) and tests.
 *
 * Precedence:
 * 1. Canonical CDP resource types map 1–1 to filter buckets (XHR/Fetch stay fetch
 *    even when the URL or mime looks like JS).
 * 2. Only missing / `other` / unmapped types are refined via MIME then URL extension.
 * 3. Source maps (`.map`) map to `other`, not JS.
 */

export type NetworkFilterBucket =
  | "fetch"
  | "js"
  | "css"
  | "img"
  | "doc"
  | "font"
  | "media"
  | "ws"
  | "other";

export interface NetworkFilterInput {
  resourceType?: string | null;
  url?: string | null;
  mimeType?: string | null;
}

const DYNAMIC_ROUTE_EXTENSIONS = new Set([".html", ".htm", ".php", ".asp", ".aspx", ".jsp"]);

const CANONICAL_TYPE_MAP: Record<string, NetworkFilterBucket> = {
  script: "js",
  stylesheet: "css",
  image: "img",
  document: "doc",
  font: "font",
  media: "media",
  texttrack: "media",
  websocket: "ws",
  xhr: "fetch",
  fetch: "fetch",
  preflight: "fetch",
  prefetch: "fetch",
  eventsource: "fetch",
  manifest: "doc",
  signedexchange: "doc",
  ping: "other",
  cspviolationreport: "other",
  fedcm: "other",
};

function getNetworkUrlExtension(url: string): string {
  try {
    const pathname = new URL(url || "", "http://x").pathname.toLowerCase();
    const lastSegment = pathname.split("/").pop() || "";
    const dot = lastSegment.lastIndexOf(".");
    if (dot > 0 && dot < lastSegment.length - 1) {
      return lastSegment.slice(dot);
    }
  } catch {
    // ignore invalid URLs
  }
  return "";
}

/**
 * Refine classification from MIME and URL when CDP resource type is missing,
 * `Other`, or otherwise unmapped.
 */
export function detectNetworkFilterFromUrlAndMime(
  url: string | null | undefined,
  mimeType: string | null | undefined,
): NetworkFilterBucket | null {
  const normalizedMimeType = String(mimeType || "").toLowerCase();

  if (normalizedMimeType.includes("javascript") || normalizedMimeType.includes("ecmascript")) {
    return "js";
  }
  if (normalizedMimeType.includes("css") && !normalizedMimeType.includes("html")) {
    return "css";
  }
  if (normalizedMimeType.includes("html")) return "doc";
  if (normalizedMimeType.startsWith("image/")) return "img";
  if (normalizedMimeType.startsWith("font/")) return "font";
  if (normalizedMimeType.startsWith("audio/") || normalizedMimeType.startsWith("video/")) {
    return "media";
  }

  const ext = getNetworkUrlExtension(url || "");
  if (ext) {
    const extMap: Record<string, NetworkFilterBucket> = {
      ".js": "js",
      ".mjs": "js",
      ".cjs": "js",
      // Source maps are not scripts; keep them out of the JS filter.
      ".map": "other",
      ".css": "css",
      ".png": "img",
      ".jpg": "img",
      ".jpeg": "img",
      ".gif": "img",
      ".svg": "img",
      ".webp": "img",
      ".ico": "img",
      ".avif": "img",
      ".bmp": "img",
      ".woff": "font",
      ".woff2": "font",
      ".ttf": "font",
      ".eot": "font",
      ".otf": "font",
      ".mp4": "media",
      ".webm": "media",
      ".mp3": "media",
      ".ogg": "media",
      ".wav": "media",
      ".html": "doc",
      ".htm": "doc",
      ".php": "doc",
      ".asp": "doc",
      ".aspx": "doc",
      ".jsp": "doc",
      ".json": "other",
      ".xml": "other",
      ".txt": "other",
      ".csv": "other",
      ".pdf": "other",
      ".zip": "other",
    };
    if (extMap[ext]) return extMap[ext];
  }

  if (normalizedMimeType.includes("json")) return "fetch";

  return null;
}

/**
 * Map a network entry to a player filter bucket (DevTools-like).
 */
export function getNetworkFilterType(input: NetworkFilterInput): NetworkFilterBucket {
  const normalizedResourceType = String(input.resourceType || "")
    .trim()
    .toLowerCase();
  const url = input.url || "";
  const mimeType = input.mimeType || "";

  // Canonical CDP types: never reclassify XHR/Fetch into js/css via MIME/URL.
  if (normalizedResourceType && CANONICAL_TYPE_MAP[normalizedResourceType]) {
    return CANONICAL_TYPE_MAP[normalizedResourceType];
  }

  // Missing, Other, or unknown: refine from MIME / URL.
  const detected = detectNetworkFilterFromUrlAndMime(url, mimeType);
  if (detected) return detected;

  // File-like URL with an unmapped extension stays other (not fetch).
  const ext = getNetworkUrlExtension(url);
  if (ext && !DYNAMIC_ROUTE_EXTENSIONS.has(ext)) {
    return "other";
  }

  return "other";
}
