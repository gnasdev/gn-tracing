/**
 * Screenshot-report capture tests.
 *
 * Every failure path here ends with the user staring at an editor that has no
 * image, so each one has to produce a message that says what went wrong rather
 * than opening the editor anyway.
 */

import { describe, expect, it, vi } from "vitest";
import type { Screenshot } from "../../packages/replay-core/src/schema/annotation";
import {
  type CaptureDeps,
  captureScreenshotForAnnotation,
  mergeAnnotatedScreenshot,
  type PendingScreenshot,
} from "./screenshot-report";

const TINY_PNG = "data:image/png;base64,iVBORw0KGgo=";

function createDeps(overrides: Partial<CaptureDeps> = {}): CaptureDeps & {
  pending: PendingScreenshot | null;
  opened: boolean;
} {
  const state = { pending: null as PendingScreenshot | null, opened: false };
  return {
    ...state,
    captureVisibleTab: vi.fn(async () => TINY_PNG),
    getTab: vi.fn(async () => ({
      windowId: 1,
      url: "https://shop.test/checkout",
      title: "Checkout",
    })),
    getViewport: vi.fn(async () => ({ width: 1440, height: 900, devicePixelRatio: 2 })),
    setPending: vi.fn(async (pending: PendingScreenshot) => {
      state.pending = pending;
    }),
    openEditor: vi.fn(async () => {
      state.opened = true;
    }),
    get pending() {
      return state.pending;
    },
    get opened() {
      return state.opened;
    },
    ...overrides,
  } as CaptureDeps & { pending: PendingScreenshot | null; opened: boolean };
}

describe("captureScreenshotForAnnotation", () => {
  it("parks the capture and opens the editor", async () => {
    const deps = createDeps();
    const result = await captureScreenshotForAnnotation(7, deps);

    expect(result).toMatchObject({ ok: true });
    expect(deps.pending?.url).toBe("https://shop.test/checkout");
    expect(deps.pending?.viewport).toEqual({ width: 1440, height: 900, devicePixelRatio: 2 });
    expect(deps.opened).toBe(true);
  });

  it("reports a capture failure instead of opening an empty editor", async () => {
    const deps = createDeps({
      captureVisibleTab: vi.fn(async () => {
        throw new Error("Cannot capture a chrome:// page");
      }),
    });

    const result = await captureScreenshotForAnnotation(7, deps);
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toMatch(/chrome:\/\//);
    expect(deps.opened).toBe(false);
  });

  it("refuses an oversized capture rather than parking megabytes in session storage", async () => {
    const deps = createDeps({
      captureVisibleTab: vi.fn(async () => `data:image/png;base64,${"A".repeat(2_000_000)}`),
    });

    const result = await captureScreenshotForAnnotation(7, deps);
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toMatch(/too large/i);
    expect(deps.pending).toBeNull();
  });

  it("rejects a non-image capture result", async () => {
    const deps = createDeps({ captureVisibleTab: vi.fn(async () => "") });
    const result = await captureScreenshotForAnnotation(7, deps);
    expect(result).toMatchObject({ ok: false });
    expect(deps.opened).toBe(false);
  });

  it("falls back to a default viewport when the page cannot be measured", async () => {
    const deps = createDeps({
      getViewport: vi.fn(async () => {
        throw new Error("no scripting permission");
      }),
    });

    const result = await captureScreenshotForAnnotation(7, deps);
    expect(result).toMatchObject({ ok: true });
    // A wrong-but-proportional viewport still places annotations sensibly,
    // because coordinates are normalised.
    expect(deps.pending?.viewport.width).toBeGreaterThan(0);
  });
});

describe("mergeAnnotatedScreenshot", () => {
  it("keeps the capture's own identity and provenance over the editor's copy", () => {
    const pending: PendingScreenshot = {
      id: "shot-real",
      imageDataUrl: TINY_PNG,
      capturedAt: 1_700_000_000_000,
      url: "https://shop.test/checkout",
      title: "Checkout",
      viewport: { width: 1440, height: 900 },
    };
    const fromEditor: Screenshot = {
      id: "shot-spoofed",
      capturedAt: 0,
      url: "https://evil.test",
      viewport: { width: 1, height: 1 },
      source: { kind: "image", path: "", mimeType: "image/jpeg" },
      annotations: [
        { id: "a1", createdAt: 1, type: "rect", rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 } },
      ],
      caption: "Total is wrong",
    };

    const merged = mergeAnnotatedScreenshot(pending, fromEditor);

    // The editor is a page; the URL and timing of the capture come from the
    // worker's own record, never from what the page sent back.
    expect(merged.screenshot.id).toBe("shot-real");
    expect(merged.screenshot.url).toBe("https://shop.test/checkout");
    expect(merged.screenshot.capturedAt).toBe(1_700_000_000_000);
    expect(merged.screenshot.viewport).toEqual({ width: 1440, height: 900 });
    // But the reporter's actual work is preserved.
    expect(merged.screenshot.annotations).toHaveLength(1);
    expect(merged.screenshot.caption).toBe("Total is wrong");
  });
});
