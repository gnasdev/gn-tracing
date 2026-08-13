/**
 * Convert two wall-clock timestamps from a recording into its elapsed duration.
 *
 * `startTime` is the epoch timestamp used to place evidence on the player
 * timeline, so duration must use that same origin rather than a service-worker
 * monotonic clock captured after media setup.
 */
export function elapsedFromRecordingStart(
  startTime: number | null,
  stopTime: number,
): number {
  if (
    typeof startTime !== "number" ||
    !Number.isFinite(startTime) ||
    !Number.isFinite(stopTime)
  ) {
    return 0;
  }
  return Math.max(0, stopTime - startTime);
}
