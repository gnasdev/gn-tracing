/**
 * Pure timeline seek / duration helpers for the replay player.
 *
 * Single behavioral source of truth:
 * - Unit tests import this module directly.
 * - Browser player loads the vendored IIFE (`player/vendor/player-timeline-seek/`)
 *   built by `npm run vendor:player-timeline-seek` as `globalThis.gnPlayerTimelineSeek`.
 *
 * After package bytes are in memory, Drive and Dropbox share this contract —
 * provider only affects download, not timeline math.
 */

/** Accept media clock as "landed" when within this window of the user target. */
export const SEEK_COMMIT_TOLERANCE_MS = 350;

export type SeekClockState = {
  /** Optimistic playhead while a user seek is in flight; null when following media. */
  pendingSeekTimeMs: number | null;
  /** Last committed / displayed timeline time. */
  currentTimeMs: number;
};

export type ReconcileSeekClockInput = SeekClockState & {
  mediaTimeMs: number;
  isDragging?: boolean;
};

export type ReconcileSeekClockResult = SeekClockState & {
  /** Caller should re-assign video.currentTime to pending target. */
  shouldRetrySeek: boolean;
  /** Pending user seek fully committed to the media clock. */
  committed: boolean;
};

export function getFiniteDurationMs(value: unknown): number {
  const durationMs = Number(value);
  return Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
}

/**
 * Decide whether to adopt the media element clock or keep the optimistic click target.
 *
 * Far `seeked` / `timeupdate` samples must NOT replace the user target — that is the
 * jump-to-click-then-snap-elsewhere bug on progressive WebM demux.
 */
export function reconcileSeekClock(
  input: ReconcileSeekClockInput,
  options: { allowRetry?: boolean; maxRetries?: number; retryCount?: number } = {},
): ReconcileSeekClockResult {
  const mediaMs = Number(input.mediaTimeMs);
  if (!Number.isFinite(mediaMs)) {
    return {
      pendingSeekTimeMs: input.pendingSeekTimeMs,
      currentTimeMs: input.currentTimeMs,
      shouldRetrySeek: false,
      committed: false,
    };
  }

  if (input.pendingSeekTimeMs == null) {
    return {
      pendingSeekTimeMs: null,
      currentTimeMs: mediaMs,
      shouldRetrySeek: false,
      committed: false,
    };
  }

  const targetMs = input.pendingSeekTimeMs;
  const delta = Math.abs(mediaMs - targetMs);
  if (delta <= SEEK_COMMIT_TOLERANCE_MS) {
    return {
      pendingSeekTimeMs: input.isDragging ? targetMs : null,
      currentTimeMs: mediaMs,
      shouldRetrySeek: false,
      committed: !input.isDragging,
    };
  }

  const maxRetries = options.maxRetries ?? 3;
  const retryCount = options.retryCount ?? 0;
  const shouldRetrySeek = Boolean(
    options.allowRetry && !input.isDragging && retryCount < maxRetries,
  );

  return {
    pendingSeekTimeMs: targetMs,
    currentTimeMs: targetMs,
    shouldRetrySeek,
    committed: false,
  };
}

export type TimelineDurationInput = {
  /** Previously displayed timeline length (may be locked). */
  durationMs: number;
  metadataDurationMs: number;
  videoDurationMs: number;
  /** Once true, duration must not shrink or jump from demux growth mid-session. */
  locked: boolean;
};

/**
 * Resolve the timeline length used for click→time mapping and the progress bar.
 *
 * Package metadata.duration is the stable source of truth. video.duration may be
 * Infinity/partial during progressive demux; adopting every growth reflows the
 * playhead leftward and looks like a seek snap-back (provider-independent, more
 * visible when demux is slow).
 */
export function resolveTimelineDurationMs(input: TimelineDurationInput): {
  durationMs: number;
  locked: boolean;
} {
  const meta = getFiniteDurationMs(input.metadataDurationMs);
  const video = getFiniteDurationMs(input.videoDurationMs);
  const previous = getFiniteDurationMs(input.durationMs);

  if (input.locked) {
    // After lock: only extend if media reports a clearly longer finite duration
    // (e.g. metadata was missing). Never shrink; never follow partial demux growth
    // unless it exceeds the lock by a full second (real longer media).
    const lockedBase = Math.max(previous, meta);
    if (video > lockedBase + 1000) {
      return { durationMs: video, locked: true };
    }
    return {
      durationMs: lockedBase > 0 ? lockedBase : Math.max(previous, video, meta),
      locked: true,
    };
  }

  // Unlocked (loading): prefer metadata; fall back to the best finite signal.
  const durationMs = Math.max(meta, video, previous);
  return { durationMs, locked: false };
}

/**
 * Map a [0,1] timeline click to an absolute time using a stable duration.
 */
export function ratioToTimeMs(ratio: number, durationMs: number): number {
  const safeRatio = Math.max(0, Math.min(1, Number(ratio) || 0));
  const duration = getFiniteDurationMs(durationMs);
  if (duration <= 0) {
    return 0;
  }
  return safeRatio * duration;
}
