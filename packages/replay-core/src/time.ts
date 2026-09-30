/**
 * Shared timestamp coercion utilities.
 *
 * The recording pipeline receives timestamps from several sources with mixed
 * units:
 *
 * - `Date.now()` / CDP `Runtime.Timestamp`: epoch milliseconds.
 * - CDP `Network.wallTime` / in-page `wallTime`: epoch seconds.
 * - CDP `Network.MonotonicTime`: monotonic seconds (NOT handled here — use
 *   `network-clock` with a learned wall-clock offset).
 * - Legacy / HAR imports: may be epoch seconds or epoch milliseconds.
 *
 * This module centralises the "is this seconds or milliseconds?" heuristic so
 * it is not duplicated across extension, storage, player, and replay-core.
 */

/**
 * Convert a loose timestamp to epoch milliseconds.
 *
 * Magnitude-based classification:
 * - `>= 1e11` → already epoch ms (current epoch ms is ~1.7e12).
 * - `>= 1e9`  → epoch seconds → multiplied by 1000.
 * - `< 1e9`   → not an epoch-based value (navigation-relative or monotonic
 *   seconds). Return `fallback` if provided, else `null`.
 */
export function coerceEpochMs(value: number | null | undefined, fallback?: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback ?? null;
  }
  if (value >= 1e11) {
    return value;
  }
  if (value >= 1e9) {
    return value * 1000;
  }
  return fallback ?? null;
}
