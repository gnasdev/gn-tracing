/**
 * Renders annotations to SVG.
 *
 * One renderer, three consumers: the extension's editor previews with it, the
 * player overlays replays with it, and the MCP/report path uses the same
 * geometry to describe shapes in words. Drawing the shapes twice — once in the
 * editor and once in the player — is how an arrow ends up pointing at a
 * different button than the reporter aimed at.
 *
 * Output is a plain SVG string with no external references, so it can be
 * inlined into a page, rasterised through an `Image`, or written into a report.
 * Nothing here touches the DOM, so it runs in Node and workerd too.
 */

import type { Annotation, NormalizedPoint, NormalizedRect, Screenshot } from "../schema/annotation";
import { normalizeRect, overlayAnnotations } from "../schema/annotation";

export const DEFAULT_ANNOTATION_COLOR = "#ff3b30";
export const DEFAULT_STROKE_WIDTH = 0.004;
export const DEFAULT_FONT_SIZE = 0.028;

export interface RenderOptions {
  /** Pixel size to render at. Defaults to the screenshot's viewport. */
  width?: number;
  height?: number;
  /** Emit only the shape elements, without the wrapping `<svg>`. */
  fragmentOnly?: boolean;
}

interface Scale {
  width: number;
  height: number;
  /** Normalised stroke units resolve against the smaller side, so a stroke
   * keeps its apparent weight on both portrait and landscape captures. */
  minSide: number;
}

function toPx(point: NormalizedPoint, scale: Scale): { x: number; y: number } {
  return { x: point.x * scale.width, y: point.y * scale.height };
}

function rectToPx(rect: NormalizedRect, scale: Scale) {
  const oriented = normalizeRect(rect);
  return {
    x: oriented.x * scale.width,
    y: oriented.y * scale.height,
    width: oriented.width * scale.width,
    height: oriented.height * scale.height,
  };
}

function strokeOf(annotation: Annotation, scale: Scale): number {
  const normalized = annotation.strokeWidth ?? DEFAULT_STROKE_WIDTH;
  // Never round to zero: a hairline that disappears on a small render is worse
  // than one that is a pixel too thick.
  return Math.max(1, normalized * scale.minSide);
}

function colorOf(annotation: Annotation): string {
  return annotation.color ?? DEFAULT_ANNOTATION_COLOR;
}

/** Escapes text for use inside an SVG text node or attribute value. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function renderArrow(annotation: Annotation & { type: "arrow" }, scale: Scale): string {
  const from = toPx(annotation.from, scale);
  const to = toPx(annotation.to, scale);
  const stroke = strokeOf(annotation, scale);
  const color = colorOf(annotation);

  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const head = Math.max(stroke * 3.5, scale.minSide * 0.018);
  const spread = Math.PI / 7;
  const left = {
    x: to.x - head * Math.cos(angle - spread),
    y: to.y - head * Math.sin(angle - spread),
  };
  const right = {
    x: to.x - head * Math.cos(angle + spread),
    y: to.y - head * Math.sin(angle + spread),
  };

  return [
    `<line x1="${round(from.x)}" y1="${round(from.y)}" x2="${round(to.x)}" y2="${round(to.y)}" stroke="${escapeXml(color)}" stroke-width="${round(stroke)}" stroke-linecap="round"/>`,
    `<polygon points="${round(to.x)},${round(to.y)} ${round(left.x)},${round(left.y)} ${round(right.x)},${round(right.y)}" fill="${escapeXml(color)}"/>`,
  ].join("");
}

function renderShape(annotation: Annotation, scale: Scale): string {
  const color = colorOf(annotation);
  const stroke = strokeOf(annotation, scale);

  switch (annotation.type) {
    case "arrow":
      return renderArrow(annotation, scale);

    case "rect": {
      const box = rectToPx(annotation.rect, scale);
      const fill = annotation.filled ? escapeXml(color) : "none";
      const fillOpacity = annotation.filled ? ' fill-opacity="0.25"' : "";
      return `<rect x="${round(box.x)}" y="${round(box.y)}" width="${round(box.width)}" height="${round(box.height)}" fill="${fill}"${fillOpacity} stroke="${escapeXml(color)}" stroke-width="${round(stroke)}"/>`;
    }

    case "ellipse": {
      const box = rectToPx(annotation.rect, scale);
      const fill = annotation.filled ? escapeXml(color) : "none";
      const fillOpacity = annotation.filled ? ' fill-opacity="0.25"' : "";
      return `<ellipse cx="${round(box.x + box.width / 2)}" cy="${round(box.y + box.height / 2)}" rx="${round(box.width / 2)}" ry="${round(box.height / 2)}" fill="${fill}"${fillOpacity} stroke="${escapeXml(color)}" stroke-width="${round(stroke)}"/>`;
    }

    case "freehand": {
      if (annotation.points.length === 0) {
        return "";
      }
      const points = annotation.points
        .map((point) => {
          const pixel = toPx(point, scale);
          return `${round(pixel.x)},${round(pixel.y)}`;
        })
        .join(" ");
      return `<polyline points="${points}" fill="none" stroke="${escapeXml(color)}" stroke-width="${round(stroke)}" stroke-linecap="round" stroke-linejoin="round"/>`;
    }

    case "text": {
      const at = toPx(annotation.at, scale);
      const fontSize = Math.max(10, (annotation.fontSize ?? DEFAULT_FONT_SIZE) * scale.height);
      // Painted twice: a dark halo under the fill, so red text stays legible on
      // both a white form and a dark dashboard.
      const common = `x="${round(at.x)}" y="${round(at.y)}" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="${round(fontSize)}" font-weight="600"`;
      const escaped = escapeXml(annotation.text);
      return [
        `<text ${common} fill="none" stroke="rgba(0,0,0,0.65)" stroke-width="${round(Math.max(2, fontSize * 0.14))}" stroke-linejoin="round">${escaped}</text>`,
        `<text ${common} fill="${escapeXml(color)}">${escaped}</text>`,
      ].join("");
    }

    case "highlight": {
      const box = rectToPx(annotation.rect, scale);
      return `<rect x="${round(box.x)}" y="${round(box.y)}" width="${round(box.width)}" height="${round(box.height)}" fill="${escapeXml(color)}" fill-opacity="0.3"/>`;
    }

    case "redact": {
      // Drawn only so an editor can show the region while the user positions
      // it. In a packaged screenshot the pixels are already destroyed and
      // `overlayAnnotations` filters these out — see the module docs on why an
      // overlay is never enough.
      const box = rectToPx(annotation.rect, scale);
      return `<rect x="${round(box.x)}" y="${round(box.y)}" width="${round(box.width)}" height="${round(box.height)}" fill="#111827"/>`;
    }

    default:
      return "";
  }
}

/** Renders a list of shapes. Unknown future shape types render as nothing. */
export function renderAnnotationsSvg(
  annotations: Annotation[],
  size: { width: number; height: number },
  options: RenderOptions = {},
): string {
  const width = options.width ?? size.width;
  const height = options.height ?? size.height;
  const scale: Scale = { width, height, minSide: Math.min(width, height) };
  const body = annotations.map((annotation) => renderShape(annotation, scale)).join("");

  if (options.fragmentOnly) {
    return body;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${round(width)} ${round(height)}" width="${round(width)}" height="${round(height)}" fill="none">${body}</svg>`;
}

/**
 * Renders the overlay for a packaged screenshot: everything except `redact`,
 * which is already baked into the image bytes.
 */
export function renderScreenshotOverlaySvg(
  screenshot: Screenshot,
  options: RenderOptions = {},
): string {
  return renderAnnotationsSvg(overlayAnnotations(screenshot), screenshot.viewport, options);
}
