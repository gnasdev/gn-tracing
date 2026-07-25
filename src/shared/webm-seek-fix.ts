/**
 * Make MediaRecorder WebM blobs seekable for random timeline access.
 *
 * Chrome MediaRecorder WebM typically lacks Cues (and often Duration). Without
 * a Cues index Chromium demuxes progressively — timeline seeks only work after
 * playback has already scanned that time.
 *
 * Single path: rebuild SeekHead + Duration + Cues via `webm-duration-fix`
 * (ts-ebml family). No duration-only fallback — that path reported success while
 * leaving files unseekable when Duration already existed without Cues.
 */

import fixWebmDurationWithCuesImport from "webm-duration-fix";

export type WebmSeekFixMethod = "cues" | "noop";

export type WebmSeekFixResult =
  | { ok: true; blob: Blob; method: WebmSeekFixMethod }
  | { ok: false; blob: Blob; reason: string };

export type MakeWebmSeekableOptions = {
  mimeType?: string;
};

/**
 * Resolve the callable from `webm-duration-fix` across CJS/ESM interop shapes.
 * Native ESM can surface `{ default: fn }` instead of `fn` when the package only
 * sets `exports.default`; calling that object throws and fail-opens to unseekable
 * MediaRecorder WebM (timeline click appears stuck until progressive demux).
 */
function resolveFixWebmDurationWithCues(mod: unknown): ((blob: Blob) => Promise<Blob>) | null {
  let current: unknown = mod;
  // Unwrap a shallow default chain (CJS ↔ ESM interop can nest once).
  for (let depth = 0; depth < 2; depth += 1) {
    if (typeof current === "function") {
      return current as (blob: Blob) => Promise<Blob>;
    }
    if (current && typeof current === "object" && "default" in current) {
      current = (current as { default: unknown }).default;
      continue;
    }
    break;
  }
  return null;
}

const fixWebmDurationWithCues = resolveFixWebmDurationWithCues(fixWebmDurationWithCuesImport);

function isWebmMime(mimeType: string | undefined): boolean {
  if (!mimeType) return true;
  const normalized = mimeType.toLowerCase();
  return normalized.includes("webm") || normalized.includes("matroska");
}

/**
 * Force a playable WebM mime on the blob. Keep existing type only when it is
 * already WebM/Matroska — never leave `application/octet-stream` (common from
 * cloud download Content-Type) on the blob URL, which can block random seeks.
 */
function withMimeType(blob: Blob, mimeType: string): Blob {
  if (!mimeType) {
    return blob;
  }
  const current = String(blob.type || "").toLowerCase();
  if (current && isWebmMime(current) && current === mimeType.toLowerCase()) {
    return blob;
  }
  if (current && isWebmMime(current) && isWebmMime(mimeType)) {
    // Already a webm family type; only replace when caller provides a more
    // specific codec string (or keep as-is when types match above).
    if (current.includes("codecs") || !mimeType.toLowerCase().includes("codecs")) {
      return blob;
    }
  }
  return new Blob([blob], { type: mimeType });
}

/**
 * Patch a MediaRecorder WebM blob so browsers can random-seek on a blob URL.
 *
 * - `ok: true, method: "cues"` — library produced a refined blob
 * - `ok: true, method: "noop"` — input is not WebM; original returned unchanged
 * - `ok: false` — fix failed; original blob returned (fail-open for upload/load)
 *
 * Never returns `ok: true` for an unfixed MediaRecorder WebM that is still
 * missing seek metadata.
 */
export async function makeWebmSeekable(
  input: Blob,
  options: MakeWebmSeekableOptions = {},
): Promise<WebmSeekFixResult> {
  const mimeType = options.mimeType || input.type || "video/webm";

  if (!(input instanceof Blob) || input.size === 0) {
    return { ok: false, blob: input, reason: "empty-blob" };
  }

  if (!isWebmMime(mimeType)) {
    return { ok: true, blob: input, method: "noop" };
  }

  if (typeof fixWebmDurationWithCues !== "function") {
    return { ok: false, blob: withMimeType(input, mimeType), reason: "webm-cues-fix-unavailable" };
  }

  try {
    const fixed = await fixWebmDurationWithCues(input);
    if (!(fixed instanceof Blob) || fixed.size === 0) {
      return { ok: false, blob: withMimeType(input, mimeType), reason: "cues-rewrite-empty" };
    }
    return { ok: true, blob: withMimeType(fixed, mimeType), method: "cues" };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "webm-cues-fix-failed";
    return { ok: false, blob: withMimeType(input, mimeType), reason };
  }
}
