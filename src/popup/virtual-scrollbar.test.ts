import { describe, expect, it } from "vitest";
import { computeScrollbarMetrics } from "./virtual-scrollbar";

const BASE = {
  scrollTop: 0,
  scrollHeight: 1000,
  clientHeight: 500,
  trackHeight: 488,
};

describe("computeScrollbarMetrics", () => {
  it("hides the thumb when content does not overflow", () => {
    const metrics = computeScrollbarMetrics({ ...BASE, scrollHeight: 500 });
    expect(metrics).toEqual({ visible: false, thumbHeight: 0, thumbTop: 0 });
    expect(computeScrollbarMetrics({ ...BASE, scrollHeight: 499 }).visible).toBe(false);
  });

  it("hides the thumb when the track has no height", () => {
    expect(computeScrollbarMetrics({ ...BASE, trackHeight: 0 }).visible).toBe(false);
  });

  it("sizes the thumb to the visible content fraction", () => {
    const metrics = computeScrollbarMetrics(BASE);
    expect(metrics.visible).toBe(true);
    // Half the content is visible → half the track.
    expect(metrics.thumbHeight).toBeCloseTo(244);
  });

  it("clamps the thumb to the minimum draggable height", () => {
    // Visible fraction is ~5% → raw thumb ~24.4px stays above the floor,
    // so shrink the viewport until the clamp engages.
    const metrics = computeScrollbarMetrics({
      ...BASE,
      clientHeight: 40,
      scrollHeight: 4000,
      trackHeight: 488,
    });
    expect(metrics.thumbHeight).toBe(24);
  });

  it("never lets the thumb exceed the track", () => {
    const metrics = computeScrollbarMetrics({
      ...BASE,
      scrollHeight: 501,
      trackHeight: 10,
    });
    expect(metrics.thumbHeight).toBeLessThanOrEqual(10);
    expect(metrics.thumbTop).toBeGreaterThanOrEqual(0);
  });

  it("maps scrollTop onto the remaining travel and clamps at both ends", () => {
    const maxScrollTop = BASE.scrollHeight - BASE.clientHeight;
    expect(computeScrollbarMetrics(BASE).thumbTop).toBe(0);

    const mid = computeScrollbarMetrics({
      ...BASE,
      scrollTop: maxScrollTop / 2,
    });
    expect(mid.thumbTop).toBeCloseTo((BASE.trackHeight - mid.thumbHeight) / 2);

    const end = computeScrollbarMetrics({ ...BASE, scrollTop: maxScrollTop });
    expect(end.thumbTop).toBeCloseTo(BASE.trackHeight - end.thumbHeight);
    expect(
      computeScrollbarMetrics({ ...BASE, scrollTop: maxScrollTop + 500 }).thumbTop,
    ).toBeCloseTo(BASE.trackHeight - end.thumbHeight);
    expect(computeScrollbarMetrics({ ...BASE, scrollTop: -20 }).thumbTop).toBe(0);
  });
});
