import { describe, expect, it } from "vitest";
import {
  eventRelativeTimesMs,
  findActiveEventIndexByRelativeMs,
  getActiveSnapshotIndexByTime,
  indexAtOrBefore,
} from "./player-clock-index";

describe("indexAtOrBefore", () => {
  it("returns -1 for empty", () => {
    expect(indexAtOrBefore([], 10)).toBe(-1);
  });

  it("returns last index with time ≤ playhead", () => {
    expect(indexAtOrBefore([0, 100, 200, 300], 200)).toBe(2);
    expect(indexAtOrBefore([0, 100, 200, 300], 199)).toBe(1);
    expect(indexAtOrBefore([0, 100, 200, 300], -1)).toBe(-1);
    expect(indexAtOrBefore([0, 100, 200, 300], 999)).toBe(3);
  });
});

describe("findActiveEventIndexByRelativeMs", () => {
  it("tracks user-event playhead", () => {
    const events = [{ relativeMs: 0 }, { relativeMs: 50 }, { relativeMs: 120 }];
    expect(findActiveEventIndexByRelativeMs(events, 50)).toBe(1);
    expect(findActiveEventIndexByRelativeMs(events, 119)).toBe(1);
    expect(findActiveEventIndexByRelativeMs([], 10)).toBe(-1);
  });

  it("reuses a precomputed times vector", () => {
    const events = [{ relativeMs: 0 }, { relativeMs: 50 }, { relativeMs: 120 }];
    const times = eventRelativeTimesMs(events);
    expect(times).toEqual([0, 50, 120]);
    expect(findActiveEventIndexByRelativeMs(events, 50, times)).toBe(1);
    expect(findActiveEventIndexByRelativeMs(events, 200, times)).toBe(2);
  });
});

describe("getActiveSnapshotIndexByTime", () => {
  it("picks latest snapshot at or before playhead", () => {
    const start = 1_000_000;
    const snaps = [
      { capturedAt: start + 0 },
      { capturedAt: start + 500 },
      { capturedAt: start + 1000 },
    ];
    expect(getActiveSnapshotIndexByTime(snaps, 500, start)).toBe(1);
    expect(getActiveSnapshotIndexByTime(snaps, 0, start)).toBe(0);
    expect(getActiveSnapshotIndexByTime(snaps, 2000, start)).toBe(2);
  });
});
