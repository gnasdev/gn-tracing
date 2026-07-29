import { describe, expect, it } from "vitest";
import {
  clampStillZoom,
  createStillViewerTransform,
  panStillViewer,
  resetStillViewerTransform,
  rotateStillCw,
  STILL_ZOOM_MAX,
  STILL_ZOOM_MIN,
  stillFigureAspectFromViewport,
  stillViewerCssTransform,
  stillZoomPercentLabel,
  zoomInStill,
  zoomOutStill,
} from "./still-viewer-transform";

describe("still-viewer-transform", () => {
  it("clamps zoom to min/max", () => {
    expect(clampStillZoom(0)).toBe(STILL_ZOOM_MIN);
    expect(clampStillZoom(100)).toBe(STILL_ZOOM_MAX);
    expect(clampStillZoom(1)).toBe(1);
  });

  it("steps zoom in and out on the 0.25 grid", () => {
    expect(zoomInStill(1)).toBe(1.25);
    expect(zoomInStill(1.25)).toBe(1.5);
    expect(zoomOutStill(1)).toBe(0.75);
    expect(zoomOutStill(STILL_ZOOM_MIN)).toBe(STILL_ZOOM_MIN);
    expect(zoomInStill(STILL_ZOOM_MAX)).toBe(STILL_ZOOM_MAX);
  });

  it("cycles rotation in 90° steps", () => {
    expect(rotateStillCw(0)).toBe(90);
    expect(rotateStillCw(90)).toBe(180);
    expect(rotateStillCw(180)).toBe(270);
    expect(rotateStillCw(270)).toBe(0);
  });

  it("builds a CSS transform string from state", () => {
    const t = createStillViewerTransform({
      scale: 1.5,
      rotationDeg: 90,
      panX: 10,
      panY: -5,
    });
    expect(stillViewerCssTransform(t)).toBe("translate(10px, -5px) rotate(90deg) scale(1.5)");
  });

  it("ignores pan while fitMode at scale 1", () => {
    const base = createStillViewerTransform({ fitMode: true, scale: 1 });
    expect(panStillViewer(base, 20, 30)).toEqual(base);
  });

  it("applies pan when zoomed", () => {
    const base = createStillViewerTransform({ fitMode: false, scale: 2, panX: 0, panY: 0 });
    expect(panStillViewer(base, 12, -4)).toMatchObject({ panX: 12, panY: -4 });
  });

  it("resets to fit defaults", () => {
    const dirty = createStillViewerTransform({
      scale: 2,
      rotationDeg: 180,
      panX: 9,
      panY: 9,
      fitMode: false,
    });
    expect(resetStillViewerTransform(dirty)).toEqual(createStillViewerTransform());
  });

  it("formats zoom percent labels", () => {
    expect(stillZoomPercentLabel(1)).toBe("100");
    expect(stillZoomPercentLabel(1.25)).toBe("125");
  });

  it("derives figure aspect from shot viewport for overlay alignment", () => {
    const aspect = stillFigureAspectFromViewport({ width: 1440, height: 900 });
    expect(aspect.aspectRatio).toBe("1440 / 900");
    expect(aspect.stillAspect).toBeCloseTo(1.6, 5);
    const fallback = stillFigureAspectFromViewport(undefined);
    expect(fallback.aspectRatio).toBe("1280 / 800");
  });
});
