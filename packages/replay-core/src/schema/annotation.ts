/**
 * Screenshot and annotation models.
 *
 * A screenshot in this format is an image plus a list of shapes drawn over it.
 * Both producers write the same structure even though they obtain the image
 * very differently: the extension rasterises the tab through
 * `chrome.tabs.captureVisibleTab`, while the in-page SDK has no such API and
 * instead records a serialized DOM snapshot the player re-renders.
 *
 * Coordinates are **normalised** to the 0..1 range against the captured
 * viewport, never raw pixels. A bug report is read on a laptop, a phone, and
 * inside a chat client's image preview; anchoring an arrow to pixel 812 of a
 * 1512-wide capture puts it somewhere else on every one of them.
 *
 * ## Redaction is not an annotation
 *
 * `redact` shapes are the one kind that must never be treated as decoration.
 * They mark regions whose pixels the producer is required to destroy *before*
 * the image is written into the package. A viewer that merely paints a black
 * box over the region leaves the original bytes in the zip, where anyone who
 * opens the archive can read them. See `bakeRedactions` in
 * `../annotate/raster.ts`, and `screenshotHasUnbakedRedactions` below for the
 * check a reader can run.
 */

/** Point in normalised viewport space: 0 = left/top edge, 1 = right/bottom. */
export interface NormalizedPoint {
  x: number;
  y: number;
}

/** Axis-aligned box in normalised viewport space. */
export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type AnnotationColor = string;

interface AnnotationBase {
  /** Stable id, so an editor can update or delete a single shape. */
  id: string;
  /** Epoch ms the shape was drawn. */
  createdAt: number;
  color?: AnnotationColor;
  /** Stroke width in normalised units of the viewport's smaller side. */
  strokeWidth?: number;
}

export type Annotation =
  | (AnnotationBase & { type: "arrow"; from: NormalizedPoint; to: NormalizedPoint })
  | (AnnotationBase & { type: "rect"; rect: NormalizedRect; filled?: boolean })
  | (AnnotationBase & { type: "ellipse"; rect: NormalizedRect; filled?: boolean })
  | (AnnotationBase & { type: "freehand"; points: NormalizedPoint[] })
  | (AnnotationBase & {
      type: "text";
      at: NormalizedPoint;
      text: string;
      /** Font size in normalised units of the viewport height. */
      fontSize?: number;
    })
  | (AnnotationBase & {
      type: "highlight";
      rect: NormalizedRect;
    })
  | (AnnotationBase & {
      type: "redact";
      rect: NormalizedRect;
      /**
       * How the producer destroyed the pixels. `"pending"` means it has not
       * done so yet — a package must never ship a `redact` shape in that state,
       * because the region is still readable in the stored image.
       */
      applied: "blur" | "fill" | "pending";
    });

export type AnnotationType = Annotation["type"];

export const ANNOTATION_TYPES: AnnotationType[] = [
  "arrow",
  "rect",
  "ellipse",
  "freehand",
  "text",
  "highlight",
  "redact",
];

/** Where a screenshot's image data lives. */
export type ScreenshotSource =
  /** A raster image entry inside the package (extension: `captureVisibleTab`). */
  | { kind: "image"; path: string; mimeType: string }
  /**
   * An index into `dom.json`'s snapshot list. Used by the in-page SDK, which
   * cannot rasterise a tab; the player re-renders the snapshot and draws the
   * annotations over it.
   */
  | { kind: "dom-snapshot"; snapshotIndex: number };

export interface Screenshot {
  id: string;
  capturedAt: number;
  /** Page URL at capture time, already redacted by the producer. */
  url?: string;
  title?: string;
  /** CSS pixel size of the captured viewport; normalised coords resolve against it. */
  viewport: { width: number; height: number; devicePixelRatio?: number };
  source: ScreenshotSource;
  annotations: Annotation[];
  /** Optional one-line caption written by the reporter. */
  caption?: string;
}

export interface ScreenshotArtifact {
  schemaVersion: 1;
  screenshots: Screenshot[];
}

/**
 * Rolling pre-bug capture ("instant replay").
 *
 * The producer keeps a bounded window of DOM snapshots while the user browses
 * and packages it only when a bug is reported, so the reporter never has to
 * reproduce the problem. `windowMs` is what the buffer was *configured* to
 * hold; `coveredMs` is what it actually held when captured, which is shorter on
 * a page that churns the DOM fast enough to hit the byte cap first.
 */
export interface InstantReplayArtifact {
  schemaVersion: 1;
  /** Configured lookback window. */
  windowMs: number;
  /** Actual span between the oldest and newest retained frame. */
  coveredMs: number;
  /** Frames dropped to stay inside the byte cap, if any. */
  droppedFrames: number;
  frames: InstantReplayFrame[];
}

export interface InstantReplayFrame {
  capturedAt: number;
  /** Offset from the first retained frame, for the player's scrubber. */
  relativeMs: number;
  documentUrl: string;
  viewport: { width: number; height: number };
  /** Serialized DOM, same node model as `dom.json`. */
  root: unknown;
}

/**
 * True when a screenshot still carries a `redact` region whose pixels were
 * never destroyed. Readers should refuse to display such a screenshot: the
 * reporter asked for the region to be hidden and the producer did not do it, so
 * showing the image would expose exactly what they tried to protect.
 */
export function screenshotHasUnbakedRedactions(screenshot: Screenshot): boolean {
  return screenshot.annotations.some(
    (annotation) => annotation.type === "redact" && annotation.applied === "pending",
  );
}

/** Annotations that are drawn over the image rather than baked into it. */
export function overlayAnnotations(screenshot: Screenshot): Annotation[] {
  return screenshot.annotations.filter((annotation) => annotation.type !== "redact");
}

/** Clamp a normalised value into 0..1; producers must not emit out-of-range coords. */
export function clampNormalized(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

/** Normalises a rect and orients it so width/height are never negative. */
export function normalizeRect(rect: NormalizedRect): NormalizedRect {
  const x1 = clampNormalized(rect.x);
  const y1 = clampNormalized(rect.y);
  const x2 = clampNormalized(rect.x + rect.width);
  const y2 = clampNormalized(rect.y + rect.height);
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}
