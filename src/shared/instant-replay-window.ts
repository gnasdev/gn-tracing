/**
 * Instant Replay window bounds (seconds) — single source of truth for store + UI.
 */

/** Default lookback window (seconds). Aligns with jam.dev's ~2 minute buffer. */
export const INSTANT_REPLAY_WINDOW_SECONDS_DEFAULT = 120;
export const INSTANT_REPLAY_WINDOW_SECONDS_MIN = 15;
export const INSTANT_REPLAY_WINDOW_SECONDS_MAX = 300;
export const INSTANT_REPLAY_WINDOW_PRESETS = [30, 60, 120, 180, 300] as const;

/**
 * Clamp Instant Replay window seconds to the product range (15–300).
 * Accepts number or numeric string; non-finite values fall back to default.
 */
export function normalizeInstantReplayWindowSeconds(
  value: unknown,
  fallback: number = INSTANT_REPLAY_WINDOW_SECONDS_DEFAULT,
): number {
  const clampedFallback = Math.min(
    INSTANT_REPLAY_WINDOW_SECONDS_MAX,
    Math.max(INSTANT_REPLAY_WINDOW_SECONDS_MIN, Math.round(fallback)),
  );
  let raw: number;
  if (typeof value === "number") {
    raw = value;
  } else if (typeof value === "string" && value.trim() !== "") {
    raw = Number(value);
  } else {
    return clampedFallback;
  }
  if (!Number.isFinite(raw)) {
    return clampedFallback;
  }
  return Math.min(
    INSTANT_REPLAY_WINDOW_SECONDS_MAX,
    Math.max(INSTANT_REPLAY_WINDOW_SECONDS_MIN, Math.round(raw)),
  );
}
