/**
 * Turning annotations into words.
 *
 * An agent reading a recording over MCP cannot see the arrow. What it can use
 * is "arrow pointing at the upper-right quadrant, captioned 'this total is
 * wrong'" — because the reporter's annotations are the closest thing in the
 * whole package to a statement of *what they thought was broken*, and that is
 * usually more valuable than any single log line.
 *
 * Position is described in ninths (top-left … bottom-right) rather than in
 * coordinates. A model given "x: 0.62, y: 0.18" has to do geometry to say
 * anything useful; a model given "top-right" can just say it.
 */

import type { Annotation, NormalizedPoint, NormalizedRect, Screenshot } from "../schema/annotation";
import { normalizeRect } from "../schema/annotation";

const VERTICAL = ["top", "middle", "bottom"] as const;
const HORIZONTAL = ["left", "center", "right"] as const;

function band(value: number): 0 | 1 | 2 {
  if (value < 1 / 3) {
    return 0;
  }
  return value < 2 / 3 ? 1 : 2;
}

/** "top-left", "middle-center", … for a point in normalised space. */
export function describePoint(point: NormalizedPoint): string {
  const vertical = VERTICAL[band(point.y)];
  const horizontal = HORIZONTAL[band(point.x)];
  return vertical === "middle" && horizontal === "center"
    ? "the centre"
    : `the ${vertical}-${horizontal}`;
}

function describeRect(rect: NormalizedRect): string {
  const oriented = normalizeRect(rect);
  const centre = {
    x: oriented.x + oriented.width / 2,
    y: oriented.y + oriented.height / 2,
  };
  const coverage = Math.round(oriented.width * oriented.height * 100);
  const size = coverage >= 50 ? "most of the page" : `about ${Math.max(1, coverage)}% of the page`;
  return `${describePoint(centre)} (${size})`;
}

/** One sentence per shape, in the order the reporter drew them. */
export function describeAnnotation(annotation: Annotation): string {
  switch (annotation.type) {
    case "arrow":
      return `Arrow drawn from ${describePoint(annotation.from)} pointing at ${describePoint(annotation.to)}.`;
    case "rect":
      return `Box drawn around ${describeRect(annotation.rect)}.`;
    case "ellipse":
      return `Circled ${describeRect(annotation.rect)}.`;
    case "freehand":
      return annotation.points.length > 0
        ? `Freehand mark starting at ${describePoint(annotation.points[0])}.`
        : "Empty freehand mark.";
    case "text":
      return `Note at ${describePoint(annotation.at)}: "${annotation.text}".`;
    case "highlight":
      return `Highlighted ${describeRect(annotation.rect)}.`;
    case "redact":
      return `Redacted ${describeRect(annotation.rect)} — those pixels were destroyed before packaging and are not recoverable.`;
    default:
      return "Unrecognised annotation.";
  }
}

export interface ScreenshotDescription {
  id: string;
  capturedAt: number;
  url?: string;
  caption?: string;
  /** True when the image is a re-rendered DOM snapshot, not a raster capture. */
  isDomSnapshot: boolean;
  annotations: string[];
  /** Text the reporter typed, verbatim — usually the highest-signal field. */
  notes: string[];
}

export function describeScreenshot(screenshot: Screenshot): ScreenshotDescription {
  return {
    id: screenshot.id,
    capturedAt: screenshot.capturedAt,
    url: screenshot.url,
    caption: screenshot.caption,
    isDomSnapshot: screenshot.source.kind === "dom-snapshot",
    annotations: screenshot.annotations.map(describeAnnotation),
    notes: screenshot.annotations
      .filter(
        (annotation): annotation is Annotation & { type: "text" } => annotation.type === "text",
      )
      .map((annotation) => annotation.text),
  };
}

/** Markdown block for the bug report and the MCP screenshot tool. */
export function renderScreenshotMarkdown(screenshot: Screenshot): string {
  const described = describeScreenshot(screenshot);
  const lines: string[] = [];

  lines.push(`### Screenshot ${described.id}`);
  if (described.caption) {
    lines.push(`> ${described.caption}`);
  }
  if (described.url) {
    lines.push(`- Page: ${described.url}`);
  }
  lines.push(
    `- Source: ${described.isDomSnapshot ? "re-rendered DOM snapshot (no raster image)" : "raster capture"}`,
  );
  lines.push(`- Viewport: ${screenshot.viewport.width}×${screenshot.viewport.height} CSS px`);

  if (described.annotations.length === 0) {
    lines.push("- No annotations.");
  } else {
    lines.push("- Reporter annotations:");
    for (const annotation of described.annotations) {
      lines.push(`  - ${annotation}`);
    }
  }

  return lines.join("\n");
}
