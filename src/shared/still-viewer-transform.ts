/**
 * Pure transform helpers for the player still viewport (zoom / rotate / pan).
 * No DOM — unit-tested and applied as CSS by player.js.
 */

export const STILL_ZOOM_MIN = 0.25;
export const STILL_ZOOM_MAX = 4;
export const STILL_ZOOM_STEP = 0.25;
export const STILL_ROTATIONS = [0, 90, 180, 270] as const;

export type StillRotationDeg = (typeof STILL_ROTATIONS)[number];

export interface StillViewerTransform {
  /** Scale multiplier; 1 = fit-baseline or 100% depending on fitMode. */
  scale: number;
  /** Clockwise rotation in degrees, one of 0/90/180/270. */
  rotationDeg: StillRotationDeg;
  /** Pan offset in CSS pixels after scale/rotate. */
  panX: number;
  panY: number;
  /**
   * When true, scale is relative to "contain" fit of the image in the viewport.
   * When false, scale 1 means natural 100% of image pixels (clamped by max).
   */
  fitMode: boolean;
}

export function createStillViewerTransform(
  overrides: Partial<StillViewerTransform> = {},
): StillViewerTransform {
  return {
    scale: 1,
    rotationDeg: 0,
    panX: 0,
    panY: 0,
    fitMode: true,
    ...overrides,
  };
}

export function clampStillZoom(scale: number): number {
  if (!Number.isFinite(scale)) {
    return 1;
  }
  return Math.min(STILL_ZOOM_MAX, Math.max(STILL_ZOOM_MIN, scale));
}

/** Next zoom step up from current scale (snaps to step grid). */
export function zoomInStill(scale: number): number {
  const current = clampStillZoom(scale);
  const stepped = Math.ceil(current / STILL_ZOOM_STEP - 1e-9) * STILL_ZOOM_STEP;
  const next = stepped <= current + 1e-9 ? stepped + STILL_ZOOM_STEP : stepped;
  return clampStillZoom(next);
}

/** Next zoom step down from current scale. */
export function zoomOutStill(scale: number): number {
  const current = clampStillZoom(scale);
  const stepped = Math.floor(current / STILL_ZOOM_STEP + 1e-9) * STILL_ZOOM_STEP;
  const next = stepped >= current - 1e-9 ? stepped - STILL_ZOOM_STEP : stepped;
  return clampStillZoom(next);
}

/** Cycle rotation 0 → 90 → 180 → 270 → 0. */
export function rotateStillCw(rotationDeg: number): StillRotationDeg {
  const normalized = ((Math.round(rotationDeg / 90) % 4) + 4) % 4;
  const next = ((normalized + 1) % 4) * 90;
  return next as StillRotationDeg;
}

/** Reset pan and put viewer back into fit mode at scale 1. */
export function resetStillViewerTransform(
  current: StillViewerTransform = createStillViewerTransform(),
): StillViewerTransform {
  return {
    ...current,
    scale: 1,
    rotationDeg: 0,
    panX: 0,
    panY: 0,
    fitMode: true,
  };
}

/**
 * Apply a pan delta. Pan is a no-op while at fit scale (scale === 1 && fitMode)
 * so the image stays centered until the user zooms in.
 */
export function panStillViewer(
  current: StillViewerTransform,
  deltaX: number,
  deltaY: number,
): StillViewerTransform {
  if (current.fitMode && current.scale <= 1 + 1e-9) {
    return current;
  }
  return {
    ...current,
    panX: current.panX + deltaX,
    panY: current.panY + deltaY,
  };
}

/** CSS transform string: translate then rotate then scale (user space). */
export function stillViewerCssTransform(transform: StillViewerTransform): string {
  const scale = clampStillZoom(transform.scale);
  const rot = transform.rotationDeg;
  return `translate(${transform.panX}px, ${transform.panY}px) rotate(${rot}deg) scale(${scale})`;
}

/** Percent label for the toolbar (e.g. 100, 125). */
export function stillZoomPercentLabel(scale: number): string {
  return String(Math.round(clampStillZoom(scale) * 100));
}

/**
 * CSS aspect geometry for the still figure (matches Screenshots tab figure).
 * Overlay SVG uses viewBox = viewport; the figure must use the same ratio.
 */
export function stillFigureAspectFromViewport(viewport?: { width?: number; height?: number }): {
  aspectRatio: string;
  stillAspect: number;
  width: number;
  height: number;
} {
  const width = Number(viewport?.width) > 0 ? Number(viewport?.width) : 1280;
  const height = Number(viewport?.height) > 0 ? Number(viewport?.height) : 800;
  return {
    width,
    height,
    aspectRatio: `${width} / ${height}`,
    stillAspect: width / height,
  };
}
