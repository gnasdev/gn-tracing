/**
 * Pure “active index at time” helpers for synced player panels.
 *
 * Binary search style: last item with time ≤ playhead (or -1 / earliest fallback).
 */

/**
 * Last index i where timesMs[i] ≤ timeMs, or -1 when empty / all after playhead.
 * `timesMs` must be sorted ascending.
 */
export function indexAtOrBefore(timesMs: readonly number[], timeMs: number): number {
  if (!timesMs.length) {
    return -1;
  }
  let lo = 0;
  let hi = timesMs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (timesMs[mid] <= timeMs) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo - 1;
}

export interface SnapshotWithCaptureTime {
  capturedAt?: unknown;
}

/**
 * Index of the snapshot active at playback time: latest with relativeMs ≤ currentTimeMs.
 * Falls back to the earliest snapshot when playback is before the first capture.
 * Returns 0 when no usable timestamps.
 */
export function getActiveSnapshotIndexByTime(
  snapshots: readonly SnapshotWithCaptureTime[],
  currentTimeMs: number,
  recordingStartTimeMs: number,
): number {
  if (!snapshots.length) {
    return 0;
  }
  let activeIndex = 0;
  let bestRel = Number.NEGATIVE_INFINITY;
  let earliestRel = Number.POSITIVE_INFINITY;
  let earliestIndex = 0;
  const startOk = Number.isFinite(recordingStartTimeMs);

  for (let i = 0; i < snapshots.length; i += 1) {
    const capturedAt = Number(snapshots[i]?.capturedAt);
    if (!Number.isFinite(capturedAt) || capturedAt <= 0 || !startOk) {
      continue;
    }
    const rel = capturedAt - recordingStartTimeMs;
    if (rel < earliestRel) {
      earliestRel = rel;
      earliestIndex = i;
    }
    if (rel <= currentTimeMs && rel >= bestRel) {
      bestRel = rel;
      activeIndex = i;
    }
  }
  return bestRel === Number.NEGATIVE_INFINITY ? earliestIndex : activeIndex;
}

/**
 * Normalized relativeMs vector for activity/user-event lists (sorted ascending
 * by the caller). Cache this when the event array is replaced so playhead ticks
 * do not re-allocate / re-map on every highlight.
 */
export function eventRelativeTimesMs(events: readonly { relativeMs?: unknown }[]): number[] {
  return events.map((e) => Math.max(0, Number(e.relativeMs) || 0));
}

/**
 * Activity / user-event active index: last event with relativeMs ≤ timeMs.
 * Pass `timesMs` (from `eventRelativeTimesMs`) to skip rebuilding the time vector.
 */
export function findActiveEventIndexByRelativeMs(
  events: readonly { relativeMs?: unknown }[],
  timeMs: number,
  timesMs?: readonly number[],
): number {
  if (!events.length) {
    return -1;
  }
  const times =
    timesMs && timesMs.length === events.length ? timesMs : eventRelativeTimesMs(events);
  return indexAtOrBefore(times, timeMs);
}
