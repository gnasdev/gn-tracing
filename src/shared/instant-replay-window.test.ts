import { describe, expect, it } from "vitest";
import {
  INSTANT_REPLAY_WINDOW_SECONDS_DEFAULT,
  INSTANT_REPLAY_WINDOW_SECONDS_MAX,
  INSTANT_REPLAY_WINDOW_SECONDS_MIN,
  normalizeInstantReplayWindowSeconds,
} from "./instant-replay-window";

describe("normalizeInstantReplayWindowSeconds", () => {
  it("uses product defaults and clamps to 15–300", () => {
    expect(INSTANT_REPLAY_WINDOW_SECONDS_DEFAULT).toBe(120);
    expect(INSTANT_REPLAY_WINDOW_SECONDS_MIN).toBe(15);
    expect(INSTANT_REPLAY_WINDOW_SECONDS_MAX).toBe(300);
    expect(normalizeInstantReplayWindowSeconds(undefined)).toBe(120);
    expect(normalizeInstantReplayWindowSeconds(10)).toBe(15);
    expect(normalizeInstantReplayWindowSeconds(999)).toBe(300);
    expect(normalizeInstantReplayWindowSeconds("120")).toBe(120);
    expect(normalizeInstantReplayWindowSeconds(45.6)).toBe(46);
  });
});
