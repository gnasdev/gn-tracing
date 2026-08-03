import { coerceEpochMs } from "../../packages/replay-core/src/time";

/**
 * Convert CDP Network.MonotonicTime (seconds) onto wall-clock epoch ms.
 *
 * Network.requestWillBeSent supplies both `timestamp` (monotonic seconds) and
 * `wallTime` (epoch seconds). WebSocket frames only carry monotonic time; the
 * offset learned from network requests maps them onto the same epoch scale used
 * by Instant Replay rolling trim (`Date.now() - windowMs`).
 */

/** wallTime_ms - monotonic_ms, learned from paired Network events. */
export function wallClockOffsetFromNetworkPair(
  monotonicSeconds: number,
  wallTimeSeconds: number,
): number | null {
  if (!Number.isFinite(monotonicSeconds) || !Number.isFinite(wallTimeSeconds)) {
    return null;
  }
  return wallTimeSeconds * 1000 - monotonicSeconds * 1000;
}

/**
 * Map a CDP monotonic timestamp (seconds) to epoch milliseconds.
 *
 * @param offsetMs Result of {@link wallClockOffsetFromNetworkPair}, or null when
 *   no network pair has been seen yet.
 * @param nowMs Fallback wall clock when offset is unknown (e.g. WS traffic before
 *   any HTTP request in the session).
 */
export function monotonicSecondsToEpochMs(
  monotonicSeconds: number,
  offsetMs: number | null,
  nowMs: number = Date.now(),
): number {
  if (!Number.isFinite(monotonicSeconds)) {
    return nowMs;
  }
  // Use the learned offset for genuine monotonic seconds (sub-epoch values).
  if (offsetMs != null && Number.isFinite(offsetMs) && monotonicSeconds < 1e9) {
    return monotonicSeconds * 1000 + offsetMs;
  }
  // Defensive: some callers pass already-epoch values. coerceEpochMs handles
  // epoch ms and epoch seconds, and falls back to nowMs when undecidable.
  return coerceEpochMs(monotonicSeconds, nowMs) ?? nowMs;
}
