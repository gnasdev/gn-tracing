/**
 * Pure helpers for deciding when to capture a network response body via CDP
 * and for draining in-flight body fetches before the debugger detaches.
 *
 * Used by `CdpManager` and unit-tested without chrome.debugger.
 */

export type ResponseBodyCaptureMode = "off" | "text" | "text-json" | "eligible";

/** Entry fields needed to resolve MIME and body-eligibility. */
export interface ResponseBodyEligibilityEntry {
  mimeType?: string | null;
  encodedDataLength?: number | null;
  responseHeaders?: Record<string, string> | null;
  responseHeadersExtra?: Record<string, string> | null;
}

/**
 * Strip parameters from a Content-Type header value.
 * `application/json; charset=utf-8` → `application/json`
 */
export function parseContentTypeMime(value: string | null | undefined): string | null {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const mediaType = raw.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mediaType || null;
}

/**
 * Find a header value case-insensitively.
 */
export function getHeaderValueCaseInsensitive(
  headers: Record<string, string> | null | undefined,
  name: string,
): string | null {
  if (!headers) return null;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target && value != null && String(value).trim()) {
      return String(value);
    }
  }
  return null;
}

/**
 * Prefer CDP `mimeType`; fall back to Content-Type on response headers.
 */
export function resolveNetworkMimeType(entry: ResponseBodyEligibilityEntry): string | null {
  const direct = entry.mimeType != null ? String(entry.mimeType).trim() : "";
  if (direct) return direct.toLowerCase();

  const fromExtra = getHeaderValueCaseInsensitive(entry.responseHeadersExtra, "content-type");
  const fromHeaders = getHeaderValueCaseInsensitive(entry.responseHeaders, "content-type");
  return parseContentTypeMime(fromExtra ?? fromHeaders);
}

function isJsonMime(mime: string): boolean {
  return mime.includes("json") || mime.includes("+json");
}

function isJavascriptMime(mime: string): boolean {
  return (
    mime.includes("javascript") ||
    mime.includes("ecmascript") ||
    mime.startsWith("application/javascript") ||
    mime.startsWith("application/x-javascript") ||
    mime.startsWith("text/javascript")
  );
}

/**
 * Whether CDP should call `Network.getResponseBody` for this finished request.
 */
export function shouldFetchResponseBody(options: {
  mode: ResponseBodyCaptureMode;
  mimeType: string | null;
  encodedDataLength: number;
  maxResponseBodyBytes: number | null;
}): boolean {
  if (options.mode === "off") return false;
  const mime = options.mimeType ? String(options.mimeType).toLowerCase().trim() : "";
  if (!mime) return false;

  if (
    options.maxResponseBodyBytes != null &&
    options.encodedDataLength > options.maxResponseBodyBytes
  ) {
    return false;
  }

  if (options.mode === "text") {
    return mime.startsWith("text/");
  }
  if (options.mode === "text-json") {
    return mime.startsWith("text/") || isJsonMime(mime);
  }

  // eligible: text-like MIME types useful for debugging
  if (mime.startsWith("text/")) return true;
  if (isJsonMime(mime)) return true;
  if (isJavascriptMime(mime)) return true;

  const eligiblePrefixes = [
    "application/xml",
    "application/xhtml+xml",
    "application/manifest+json",
    "application/ld+json",
    "image/svg+xml",
  ];
  return eligiblePrefixes.some((prefix) => mime.startsWith(prefix));
}

/**
 * Convenience: resolve MIME from the entry then apply eligibility.
 */
export function shouldFetchResponseBodyForEntry(
  mode: ResponseBodyCaptureMode,
  entry: ResponseBodyEligibilityEntry,
  maxResponseBodyBytes: number | null,
): boolean {
  return shouldFetchResponseBody({
    mode,
    mimeType: resolveNetworkMimeType(entry),
    encodedDataLength: entry.encodedDataLength ?? 0,
    maxResponseBodyBytes,
  });
}

/**
 * Ordered detach sequence: body fetches must settle while the debugger is still
 * attached, then pending requests finalize, then the debugger detaches.
 *
 * Tests assert this order via spies; `CdpManager.detach` is the production caller.
 */
export async function drainBodyFetchesThenDetach(ops: {
  bodyFetches: Iterable<Promise<unknown>>;
  finalizePending: () => void;
  detachDebugger: () => Promise<void>;
}): Promise<void> {
  await Promise.allSettled(Array.from(ops.bodyFetches));
  ops.finalizePending();
  await ops.detachDebugger();
}

/** Display modes for the network detail response-body section. */
export type NetworkResponseBodyDisplayKind = "text" | "binary" | "missing";

export interface NetworkResponseBodyDisplay {
  kind: NetworkResponseBodyDisplayKind;
  /** Decoded/plain body text when kind is "text"; otherwise empty. */
  text: string;
}

/**
 * Decide what the player should show for a network response body payload.
 * Pure: no DOM / i18n.
 */
export function resolveNetworkResponseBodyDisplay(content: {
  text?: string | null;
  encoding?: string | null;
  /** Already-decoded text when encoding was base64; empty means binary or undecodable. */
  decodedText?: string | null;
}): NetworkResponseBodyDisplay {
  const raw = content.text == null ? "" : String(content.text);
  if (!raw) {
    return { kind: "missing", text: "" };
  }
  if (content.encoding === "base64") {
    const decoded = content.decodedText == null ? "" : String(content.decodedText);
    if (!decoded) {
      return { kind: "binary", text: "" };
    }
    return { kind: "text", text: decoded };
  }
  return { kind: "text", text: raw };
}
