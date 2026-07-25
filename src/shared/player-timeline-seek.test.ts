import { describe, expect, it } from "vitest";
import {
  getFiniteDurationMs,
  ratioToTimeMs,
  reconcileSeekClock,
  resolveTimelineDurationMs,
  SEEK_COMMIT_TOLERANCE_MS,
} from "./player-timeline-seek";

describe("reconcileSeekClock", () => {
  it("follows media when no pending user seek", () => {
    const result = reconcileSeekClock({
      pendingSeekTimeMs: null,
      currentTimeMs: 1000,
      mediaTimeMs: 2500,
    });
    expect(result.currentTimeMs).toBe(2500);
    expect(result.pendingSeekTimeMs).toBeNull();
    expect(result.shouldRetrySeek).toBe(false);
  });

  it("keeps optimistic target when media is far (no snap-back)", () => {
    const result = reconcileSeekClock({
      pendingSeekTimeMs: 30_000,
      currentTimeMs: 30_000,
      mediaTimeMs: 1_200,
      isDragging: false,
    });
    expect(result.currentTimeMs).toBe(30_000);
    expect(result.pendingSeekTimeMs).toBe(30_000);
    expect(result.committed).toBe(false);
    expect(result.shouldRetrySeek).toBe(false);
  });

  it("requests retry when allowRetry and under max retries", () => {
    const result = reconcileSeekClock(
      {
        pendingSeekTimeMs: 30_000,
        currentTimeMs: 30_000,
        mediaTimeMs: 0,
      },
      { allowRetry: true, retryCount: 0, maxRetries: 3 },
    );
    expect(result.shouldRetrySeek).toBe(true);
    expect(result.currentTimeMs).toBe(30_000);
  });

  it("does not retry while dragging (stale intermediate seeked)", () => {
    const result = reconcileSeekClock(
      {
        pendingSeekTimeMs: 40_000,
        currentTimeMs: 40_000,
        mediaTimeMs: 10_000,
        isDragging: true,
      },
      { allowRetry: true, retryCount: 0 },
    );
    expect(result.shouldRetrySeek).toBe(false);
    expect(result.pendingSeekTimeMs).toBe(40_000);
  });

  it("commits when media lands within tolerance", () => {
    const target = 20_000;
    const result = reconcileSeekClock({
      pendingSeekTimeMs: target,
      currentTimeMs: target,
      mediaTimeMs: target + SEEK_COMMIT_TOLERANCE_MS - 1,
    });
    expect(result.committed).toBe(true);
    expect(result.pendingSeekTimeMs).toBeNull();
    expect(result.currentTimeMs).toBe(target + SEEK_COMMIT_TOLERANCE_MS - 1);
  });

  it("keeps pending while dragging even if media is close", () => {
    const result = reconcileSeekClock({
      pendingSeekTimeMs: 15_000,
      currentTimeMs: 15_000,
      mediaTimeMs: 15_100,
      isDragging: true,
    });
    expect(result.pendingSeekTimeMs).toBe(15_000);
    expect(result.committed).toBe(false);
  });
});

describe("resolveTimelineDurationMs", () => {
  it("prefers metadata while unlocked", () => {
    const result = resolveTimelineDurationMs({
      durationMs: 0,
      metadataDurationMs: 45_000,
      videoDurationMs: 0,
      locked: false,
    });
    expect(result.durationMs).toBe(45_000);
  });

  it("does not reflow playhead when video.duration grows during demux after lock", () => {
    // Classic progressive WebM: duration ticks up as clusters are scanned.
    // Growing the timeline scale moves the handle left without a user seek.
    const locked = resolveTimelineDurationMs({
      durationMs: 45_000,
      metadataDurationMs: 45_000,
      videoDurationMs: 12_000,
      locked: true,
    });
    expect(locked.durationMs).toBe(45_000);

    const grown = resolveTimelineDurationMs({
      durationMs: 45_000,
      metadataDurationMs: 45_000,
      videoDurationMs: 30_000,
      locked: true,
    });
    expect(grown.durationMs).toBe(45_000);
  });

  it("extends locked duration only when media is clearly longer than metadata", () => {
    const result = resolveTimelineDurationMs({
      durationMs: 45_000,
      metadataDurationMs: 45_000,
      videoDurationMs: 50_000,
      locked: true,
    });
    // 5s longer > 1s threshold
    expect(result.durationMs).toBe(50_000);
  });
});

describe("ratioToTimeMs", () => {
  it("maps click ratio with stable duration", () => {
    expect(ratioToTimeMs(0.5, 60_000)).toBe(30_000);
    expect(ratioToTimeMs(0, 60_000)).toBe(0);
    expect(ratioToTimeMs(1, 60_000)).toBe(60_000);
    expect(ratioToTimeMs(0.5, 0)).toBe(0);
  });
});

describe("getFiniteDurationMs", () => {
  it("rejects non-finite and non-positive values", () => {
    expect(getFiniteDurationMs(Infinity)).toBe(0);
    expect(getFiniteDurationMs(NaN)).toBe(0);
    expect(getFiniteDurationMs(-1)).toBe(0);
    expect(getFiniteDurationMs(1200)).toBe(1200);
  });
});
