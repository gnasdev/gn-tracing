/**
 * Destroying redacted pixels in a screenshot.
 *
 * This is the step that makes a `redact` annotation mean anything. Painting a
 * black rectangle in the viewer hides the region from whoever is looking at the
 * player; the original pixels are still in `screenshot.jpg` inside the zip, and
 * the zip is the thing people forward to each other. Redaction has to happen to
 * the bytes, once, before packaging.
 *
 * The obfuscation is a **downscale-then-upscale mosaic**, not a Gaussian blur.
 * A blur is a convolution: given the kernel and enough patience it is partly
 * invertible, and published attacks have recovered text from blurred
 * screenshots. Averaging a region down to a handful of pixels throws the
 * information away outright — there is nothing left to deconvolve.
 *
 * Runs wherever `OffscreenCanvas` and `createImageBitmap` exist: the extension's
 * offscreen document and any modern page. It is producer-side only, so the
 * Node/workerd readers never load it.
 */

import type { Annotation, Screenshot } from "../schema/annotation";
import { normalizeRect } from "../schema/annotation";

/** Mosaic cell target: each redacted region collapses to at most this many cells per side. */
const MOSAIC_CELLS = 6;

/** Regions smaller than this in either axis are filled rather than mosaicked. */
const MIN_MOSAIC_PX = 8;

export interface BakeRedactionsResult {
  bytes: Uint8Array;
  mimeType: string;
  /** Number of `redact` regions whose pixels were destroyed. */
  applied: number;
}

export interface BakeOptions {
  /** Output type. JPEG keeps packages small; PNG avoids recompression artefacts. */
  mimeType?: "image/jpeg" | "image/png";
  quality?: number;
}

interface CanvasLike {
  width: number;
  height: number;
  getContext(id: "2d"): OffscreenCanvasRenderingContext2D | null;
  convertToBlob(options?: { type?: string; quality?: number }): Promise<Blob>;
}

function canRaster(): boolean {
  return (
    typeof globalThis.OffscreenCanvas === "function" &&
    typeof globalThis.createImageBitmap === "function"
  );
}

function createCanvas(width: number, height: number): CanvasLike {
  return new OffscreenCanvas(width, height) as unknown as CanvasLike;
}

/**
 * Rewrites the image so every `redact` region is unreadable, and marks those
 * annotations as applied.
 *
 * Fails loudly rather than silently returning the original bytes: a caller that
 * mistakes an unredacted image for a redacted one would package the very data
 * the reporter asked to hide.
 */
export async function bakeRedactions(
  imageBytes: Uint8Array,
  imageMimeType: string,
  screenshot: Screenshot,
  options: BakeOptions = {},
): Promise<BakeRedactionsResult> {
  const redactions = screenshot.annotations.filter(
    (annotation): annotation is Annotation & { type: "redact" } => annotation.type === "redact",
  );

  if (redactions.length === 0) {
    return { bytes: imageBytes, mimeType: imageMimeType, applied: 0 };
  }

  if (!canRaster()) {
    throw new Error(
      "Cannot redact this screenshot: the runtime has no OffscreenCanvas. Refusing to package an image whose redacted regions are still readable.",
    );
  }

  const bitmap = await createImageBitmap(
    new Blob([imageBytes as BlobPart], { type: imageMimeType }),
  );
  const canvas = createCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new Error("Cannot redact this screenshot: 2D canvas context is unavailable.");
  }

  ctx.drawImage(bitmap as unknown as CanvasImageSource, 0, 0);
  bitmap.close();

  for (const redaction of redactions) {
    const rect = normalizeRect(redaction.rect);
    const x = Math.floor(rect.x * canvas.width);
    const y = Math.floor(rect.y * canvas.height);
    const width = Math.ceil(rect.width * canvas.width);
    const height = Math.ceil(rect.height * canvas.height);
    if (width <= 0 || height <= 0) {
      continue;
    }

    if (redaction.applied === "fill" || width < MIN_MOSAIC_PX || height < MIN_MOSAIC_PX) {
      ctx.fillStyle = "#111827";
      ctx.fillRect(x, y, width, height);
      redaction.applied = "fill";
      continue;
    }

    mosaicRegion(ctx, canvas, x, y, width, height);
    redaction.applied = "blur";
  }

  const mimeType = options.mimeType ?? (imageMimeType === "image/png" ? "image/png" : "image/jpeg");
  const blob = await canvas.convertToBlob({
    type: mimeType,
    ...(mimeType === "image/jpeg" ? { quality: options.quality ?? 0.85 } : {}),
  });

  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    mimeType,
    applied: redactions.length,
  };
}

/**
 * Collapses a region to a coarse grid and stretches it back. Drawing through a
 * tiny intermediate canvas is what discards the detail; drawing the region onto
 * itself at a smaller scale would leave the original pixels underneath.
 */
function mosaicRegion(
  ctx: OffscreenCanvasRenderingContext2D,
  canvas: CanvasLike,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  const cellsX = Math.max(1, Math.min(MOSAIC_CELLS, Math.floor(width / MIN_MOSAIC_PX)));
  const cellsY = Math.max(1, Math.min(MOSAIC_CELLS, Math.floor(height / MIN_MOSAIC_PX)));

  const small = createCanvas(cellsX, cellsY);
  const smallCtx = small.getContext("2d");
  if (!smallCtx) {
    ctx.fillStyle = "#111827";
    ctx.fillRect(x, y, width, height);
    return;
  }

  smallCtx.imageSmoothingEnabled = true;
  smallCtx.drawImage(
    canvas as unknown as CanvasImageSource,
    x,
    y,
    width,
    height,
    0,
    0,
    cellsX,
    cellsY,
  );

  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small as unknown as CanvasImageSource, 0, 0, cellsX, cellsY, x, y, width, height);
  ctx.imageSmoothingEnabled = true;
}

/**
 * Rasterises an SVG overlay onto an image, producing a single flattened frame.
 *
 * Used for the "download this screenshot" path and for handing an agent one
 * image that already carries the reporter's arrows, rather than an image plus a
 * separate list of coordinates it has to imagine.
 */
export async function flattenScreenshot(
  imageBytes: Uint8Array,
  imageMimeType: string,
  overlaySvg: string,
  options: BakeOptions = {},
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  if (!canRaster()) {
    throw new Error("Cannot flatten this screenshot: the runtime has no OffscreenCanvas.");
  }

  const base = await createImageBitmap(new Blob([imageBytes as BlobPart], { type: imageMimeType }));
  const canvas = createCanvas(base.width, base.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    base.close();
    throw new Error("Cannot flatten this screenshot: 2D canvas context is unavailable.");
  }

  ctx.drawImage(base as unknown as CanvasImageSource, 0, 0);
  base.close();

  const overlayBitmap = await createImageBitmap(
    new Blob([overlaySvg], { type: "image/svg+xml" }),
  ).catch(() => null);
  if (overlayBitmap) {
    ctx.drawImage(overlayBitmap as unknown as CanvasImageSource, 0, 0, canvas.width, canvas.height);
    overlayBitmap.close();
  }

  const mimeType = options.mimeType ?? "image/png";
  const blob = await canvas.convertToBlob({
    type: mimeType,
    ...(mimeType === "image/jpeg" ? { quality: options.quality ?? 0.9 } : {}),
  });
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mimeType };
}
