import { describe, expect, it } from "vitest";
import {
  aggregateLoadingProgress,
  type LoadingProgressEntry,
  mergeLoadingEntry,
  normalizeLoadingStatus,
} from "./player-loading-progress";

describe("normalizeLoadingStatus", () => {
  it("accepts known statuses and falls back to queued", () => {
    expect(normalizeLoadingStatus("loaded")).toBe("loaded");
    expect(normalizeLoadingStatus("LOADING")).toBe("loading");
    expect(normalizeLoadingStatus("nope")).toBe("queued");
  });
});

describe("aggregateLoadingProgress", () => {
  it("computes percent from uploaded vs total including expected video floor", () => {
    const entries: LoadingProgressEntry[] = [
      { loaded: 50, total: 100, group: "video", label: "v", status: "loading" },
      { loaded: 10, total: 10, group: "other", label: "m", status: "loaded" },
    ];
    const snap = aggregateLoadingProgress(entries, 200);
    // video total floor 200 + other 10 = 210; uploaded 50+10 = 60
    expect(snap.totalBytes).toBe(210);
    expect(snap.uploadedBytes).toBe(60);
    expect(snap.percent).toBeCloseTo((60 / 210) * 100, 5);
  });

  it("returns 0 percent when no totals", () => {
    expect(aggregateLoadingProgress([], 0)).toEqual({
      uploadedBytes: 0,
      totalBytes: 0,
      percent: 0,
    });
  });
});

describe("mergeLoadingEntry", () => {
  it("merges patch onto previous entry", () => {
    const next = mergeLoadingEntry(
      { loaded: 1, total: 10, group: "video", label: "a", status: "queued" },
      "k",
      { loaded: 5, status: "loading" },
    );
    expect(next).toEqual({
      loaded: 5,
      total: 10,
      group: "video",
      label: "a",
      status: "loading",
    });
  });
});
