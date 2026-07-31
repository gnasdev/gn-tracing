/**
 * Renderer tests.
 *
 * The properties worth pinning are the ones that would silently misplace a
 * reporter's arrow: normalised coordinates must scale to whatever size the
 * consumer renders at, and a redaction must never reach the overlay path.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Annotation, Screenshot } from "../schema/annotation";
import { describeAnnotation, describePoint, renderScreenshotMarkdown } from "./describe";
import { ensureSvgPixelSize } from "./raster";
import { escapeXml, renderAnnotationsSvg, renderScreenshotOverlaySvg } from "./svg";

const baseShape = { id: "a1", createdAt: 1_700_000_000_000 };

function screenshotWith(annotations: Annotation[]): Screenshot {
  return {
    id: "shot-1",
    capturedAt: 1_700_000_000_000,
    viewport: { width: 1000, height: 500 },
    source: { kind: "image", path: "screenshots/shot-1.png", mimeType: "image/png" },
    annotations,
  };
}

describe("renderAnnotationsSvg", () => {
  it("scales normalised coordinates to the requested render size", () => {
    const arrow: Annotation = {
      ...baseShape,
      type: "arrow",
      from: { x: 0, y: 0 },
      to: { x: 0.5, y: 0.5 },
    };

    const svg = renderAnnotationsSvg([arrow], { width: 1000, height: 400 });
    expect(svg).toContain('x2="500"');
    expect(svg).toContain('y2="200"');

    // Same shape, half the render size: the arrow must land on the same spot
    // proportionally, which is the whole reason coordinates are normalised.
    const half = renderAnnotationsSvg(
      [arrow],
      { width: 1000, height: 400 },
      { width: 500, height: 200 },
    );
    expect(half).toContain('x2="250"');
    expect(half).toContain('y2="100"');
  });

  it("keeps every shape inside the viewBox for any normalised input", () => {
    const point = fc.record({
      x: fc.double({ min: 0, max: 1, noNaN: true }),
      y: fc.double({ min: 0, max: 1, noNaN: true }),
    });

    fc.assert(
      fc.property(point, point, (from, to) => {
        // `fragmentOnly` so the xmlns URL's own digits are not scraped as
        // geometry — measuring the shapes means measuring only the shapes.
        const svg = renderAnnotationsSvg(
          [{ ...baseShape, type: "arrow", from, to }],
          { width: 800, height: 600 },
          { fragmentOnly: true },
        );
        const numbers = [...svg.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
        // Arrowheads extend a little past the endpoint, so allow a margin; the
        // point is that nothing lands wildly off-canvas.
        expect(Math.max(...numbers)).toBeLessThan(900);
        expect(Math.min(...numbers)).toBeGreaterThan(-100);
      }),
      { numRuns: 50 },
    );
  });

  it("escapes text so a note cannot inject markup into the overlay", () => {
    const svg = renderAnnotationsSvg(
      [
        {
          ...baseShape,
          type: "text",
          at: { x: 0.1, y: 0.1 },
          text: "</text><script>alert(1)</script>",
        },
      ],
      { width: 400, height: 300 },
    );

    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
  });

  it("omits redactions from the overlay because their pixels are already gone", () => {
    const shot = screenshotWith([
      {
        ...baseShape,
        type: "redact",
        rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        applied: "blur",
      },
      { ...baseShape, id: "a2", type: "rect", rect: { x: 0.5, y: 0.5, width: 0.2, height: 0.2 } },
    ]);

    const svg = renderScreenshotOverlaySvg(shot);
    expect(svg).toContain("<rect");
    // Only one rect: the annotation, not the redaction.
    expect(svg.match(/<rect/g)).toHaveLength(1);
    expect(svg).not.toContain("#111827");
  });

  it("orients a rect drawn right-to-left or bottom-to-top", () => {
    const svg = renderAnnotationsSvg(
      [{ ...baseShape, type: "rect", rect: { x: 0.8, y: 0.8, width: -0.3, height: -0.3 } }],
      { width: 1000, height: 1000 },
    );
    expect(svg).toContain('x="500"');
    expect(svg).toContain('y="500"');
    expect(svg).toContain('width="300"');
    expect(svg).toContain('height="300"');
  });
});

describe("escapeXml", () => {
  it("escapes every character that could break out of an attribute or node", () => {
    expect(escapeXml(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&apos;");
  });
});

describe("describe", () => {
  it("names the region a point falls in", () => {
    expect(describePoint({ x: 0.1, y: 0.1 })).toBe("the top-left");
    expect(describePoint({ x: 0.9, y: 0.9 })).toBe("the bottom-right");
    expect(describePoint({ x: 0.5, y: 0.5 })).toBe("the centre");
  });

  it("says plainly that redacted pixels are gone, not merely hidden", () => {
    const text = describeAnnotation({
      ...baseShape,
      type: "redact",
      rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
      applied: "blur",
    });
    expect(text).toMatch(/destroyed before packaging/);
    expect(text).toMatch(/not recoverable/);
  });

  it("surfaces the reporter's own words in the markdown block", () => {
    const shot = screenshotWith([
      { ...baseShape, type: "text", at: { x: 0.5, y: 0.2 }, text: "this total is wrong" },
    ]);
    shot.caption = "Coupon applied twice";

    const markdown = renderScreenshotMarkdown(shot);
    expect(markdown).toContain("Coupon applied twice");
    expect(markdown).toContain("this total is wrong");
    expect(markdown).toContain("raster capture");
  });

  it("tells a reader when there is no real image behind a screenshot", () => {
    const shot = screenshotWith([]);
    shot.source = { kind: "dom-snapshot", snapshotIndex: 0 };
    expect(renderScreenshotMarkdown(shot)).toContain("re-rendered DOM snapshot");
  });
});

describe("ensureSvgPixelSize", () => {
  it("forces width/height so SVG rasterisers know the pixel box", () => {
    const arrow: Annotation = {
      ...baseShape,
      type: "arrow",
      from: { x: 0.1, y: 0.1 },
      to: { x: 0.9, y: 0.9 },
      color: "#ff0000",
    };
    const raw = renderAnnotationsSvg([arrow], { width: 100, height: 50 });
    const sized = ensureSvgPixelSize(raw, 1440, 900);
    expect(sized).toMatch(/width="1440"/);
    expect(sized).toMatch(/height="900"/);
    expect(sized).toContain("xmlns=");
  });
});
