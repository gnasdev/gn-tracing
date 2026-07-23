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

import fixWebmDurationWithCues from "webm-duration-fix";

export type WebmSeekFixMethod = "cues" | "noop";

export type WebmSeekFixResult =
  | { ok: true; blob: Blob; method: WebmSeekFixMethod }
  | { ok: false; blob: Blob; reason: string };

export type MakeWebmSeekableOptions = {
  mimeType?: string;
};

function isWebmMime(mimeType: string | undefined): boolean {
  if (!mimeType) return true;
  const normalized = mimeType.toLowerCase();
  return normalized.includes("webm") || normalized.includes("matroska");
}

function withMimeType(blob: Blob, mimeType: string): Blob {
  if (blob.type || !mimeType) {
    return blob;
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

  try {
    const fixed = await fixWebmDurationWithCues(input);
    if (!(fixed instanceof Blob) || fixed.size === 0) {
      return { ok: false, blob: input, reason: "cues-rewrite-empty" };
    }
    return { ok: true, blob: withMimeType(fixed, mimeType), method: "cues" };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "webm-cues-fix-failed";
    return { ok: false, blob: input, reason };
  }
}
