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
 * Load an SVG markup string as a drawable image.
 *
 * Chromium rejects `createImageBitmap` on `image/svg+xml` blobs (and silently
 * failed in the old flatten path, which is why "Copy image" shipped bare
 * stills). Prefer `HTMLImageElement` + data URL; fall back to object URL.
 */
async function loadSvgDrawable(
  overlaySvg: string,
  width: number,
  height: number,
): Promise<{ source: CanvasImageSource; close: () => void }> {
  const svg = ensureSvgPixelSize(overlaySvg, width, height);
  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

  if (typeof Image === "function") {
    const image = await loadHtmlImage(dataUrl);
    return {
      source: image as unknown as CanvasImageSource,
      close: () => {
        image.src = "";
      },
    };
  }

  // Workers / environments without HTMLImageElement: try createImageBitmap via
  // object URL (still more reliable than a bare SVG blob in some runtimes).
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const objectUrl = URL.createObjectURL(blob);
  try {
    const bitmap = await createImageBitmap(blob).catch(async () => {
      // Last resort: fetch the object URL as a bitmap of a rendered image.
      if (typeof Image === "function") {
        const image = await loadHtmlImage(objectUrl);
        return createImageBitmap(image);
      }
      throw new Error("Cannot rasterise SVG overlay: no Image or createImageBitmap path.");
    });
    return {
      source: bitmap as unknown as CanvasImageSource,
      close: () => {
        if (typeof (bitmap as ImageBitmap).close === "function") {
          (bitmap as ImageBitmap).close();
        }
      },
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function loadHtmlImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to load SVG overlay for flatten."));
    image.src = src;
  });
}

/**
 * Force width/height attributes so SVG→bitmap renderers know the pixel size.
 * ViewBox alone is not enough for createImageBitmap / Image in Chromium.
 */
export function ensureSvgPixelSize(svg: string, width: number, height: number): string {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  let out = svg.trim();
  if (!out.includes("xmlns=")) {
    out = out.replace(/<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  if (/\bwidth\s*=/.test(out)) {
    out = out.replace(/\bwidth\s*=\s*["'][^"']*["']/, `width="${w}"`);
  } else {
    out = out.replace(/<svg\b/, `<svg width="${w}"`);
  }
  if (/\bheight\s*=/.test(out)) {
    out = out.replace(/\bheight\s*=\s*["'][^"']*["']/, `height="${h}"`);
  } else {
    out = out.replace(/<svg\b/, `<svg height="${h}"`);
  }
  return out;
}

/**
 * Rasterises an SVG overlay onto an image, producing a single flattened frame.
 *
 * Used for "Copy image", download paths, and handing an agent one image that
 * already carries the reporter's arrows — not an image plus a separate list of
 * coordinates.
 *
 * Throws when a non-empty overlay cannot be rasterised, so callers never
 * silently ship a bare still that looked annotated in the editor.
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

  const trimmedOverlay = overlaySvg?.trim() ?? "";
  if (trimmedOverlay.length > 0) {
    const overlay = await loadSvgDrawable(trimmedOverlay, canvas.width, canvas.height);
    try {
      ctx.drawImage(overlay.source, 0, 0, canvas.width, canvas.height);
    } finally {
      overlay.close();
    }
  }

  const mimeType = options.mimeType ?? "image/png";
  const blob = await canvas.convertToBlob({
    type: mimeType,
    ...(mimeType === "image/jpeg" ? { quality: options.quality ?? 0.9 } : {}),
  });
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mimeType };
}
