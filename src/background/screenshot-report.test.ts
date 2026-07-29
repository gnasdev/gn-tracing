/**
 * Screenshot-report capture tests.
 *
 * Every failure path here ends with the user staring at an editor that has no
 * image, so each one has to produce a message that says what went wrong rather
 * than opening the editor anyway.
 */

import { describe, expect, it, vi } from "vitest";
import type {
  InstantReplayArtifact,
  Screenshot,
} from "../../packages/replay-core/src/schema/annotation";
import {
  buildInstantReplayPending,
  type CaptureDeps,
  captureScreenshotForAnnotation,
  defaultCaptionForPending,
  mergeAnnotatedScreenshot,
  openAnnotateEditorTab,
  type PendingCapture,
  parsePendingCapture,
  parsePendingStillView,
  resolveInstantReplayForSave,
  toAnnotatePendingView,
} from "./screenshot-report";

const TINY_PNG = "data:image/png;base64,iVBORw0KGgo=";

const sampleIrArtifact: InstantReplayArtifact = {
  schemaVersion: 1,
  windowMs: 120_000,
  coveredMs: 2_000,
  droppedFrames: 0,
  frames: [
    {
      capturedAt: 1_000,
      relativeMs: 0,
      documentUrl: "https://example.com",
      viewport: { width: 800, height: 600 },
      root: { nodeType: 9, nodeName: "#document" },
    },
  ],
};

function createDeps(overrides: Partial<CaptureDeps> = {}): CaptureDeps & {
  pending: PendingCapture | null;
  opened: boolean;
} {
  const state = { pending: null as PendingCapture | null, opened: false };
  return {
    ...state,
    captureVisibleTab: vi.fn(async () => TINY_PNG),
    getTab: vi.fn(async () => ({
      windowId: 1,
      url: "https://shop.test/checkout",
      title: "Checkout",
    })),
    getViewport: vi.fn(async () => ({ width: 1440, height: 900, devicePixelRatio: 2 })),
    setPending: vi.fn(async (pending: PendingCapture) => {
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
  } as CaptureDeps & { pending: PendingCapture | null; opened: boolean };
}

describe("captureScreenshotForAnnotation", () => {
  it("parks a screenshot-kind capture and opens the editor", async () => {
    const deps = createDeps();
    const result = await captureScreenshotForAnnotation(7, deps);

    expect(result).toMatchObject({ ok: true });
    expect(deps.pending?.kind).toBe("screenshot");
    expect(deps.pending?.url).toBe("https://shop.test/checkout");
    expect(deps.pending?.viewport).toEqual({ width: 1440, height: 900, devicePixelRatio: 2 });
    expect(deps.opened).toBe(true);
  });

  it("parks IR kind with frozen lookback via finalizePending", async () => {
    const deps = createDeps({
      finalizePending: (base) =>
        buildInstantReplayPending(base, {
          artifact: sampleIrArtifact,
          evidence: { console: [], network: [], websocket: [], storage: [] },
        }),
    });
    const result = await captureScreenshotForAnnotation(7, deps);
    expect(result).toMatchObject({ ok: true });
    expect(deps.pending?.kind).toBe("instant-replay");
    if (deps.pending?.kind === "instant-replay") {
      expect(deps.pending.frozenInstantReplay.artifact.coveredMs).toBe(2_000);
      expect(deps.pending.id.startsWith("ir-")).toBe(true);
    }
    expect(deps.opened).toBe(true);
  });

  it("does not open the editor when setPending fails (quota/storage)", async () => {
    const deps = createDeps({
      setPending: vi.fn(async () => {
        throw new Error("QUOTA_BYTES exceeded");
      }),
    });
    const result = await captureScreenshotForAnnotation(7, deps);
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toMatch(/QUOTA_BYTES|store/i);
    expect(deps.opened).toBe(false);
  });

  it("does not open the editor when IR finalize rejects empty lookback", async () => {
    const deps = createDeps({
      finalizePending: (base) =>
        buildInstantReplayPending(base, {
          artifact: { ...sampleIrArtifact, frames: [] },
          evidence: null,
        }),
    });
    const result = await captureScreenshotForAnnotation(7, deps);
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toMatch(/empty|lookback/i);
    expect(deps.opened).toBe(false);
    expect(deps.pending).toBeNull();
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

describe("parsePendingCapture", () => {
  it("accepts screenshot kind and rejects IR without frames", () => {
    const shot = parsePendingCapture({
      kind: "screenshot",
      id: "shot-1",
      imageDataUrl: TINY_PNG,
      capturedAt: 1,
      tabId: 2,
      viewport: { width: 10, height: 10 },
    });
    expect(shot?.kind).toBe("screenshot");

    const badIr = parsePendingCapture({
      kind: "instant-replay",
      id: "ir-1",
      imageDataUrl: TINY_PNG,
      capturedAt: 1,
      tabId: 2,
      viewport: { width: 10, height: 10 },
      frozenInstantReplay: {
        artifact: { ...sampleIrArtifact, frames: [] },
        evidence: null,
      },
    });
    expect(badIr).toBeNull();
  });

  it("requires frozenInstantReplay for instant-replay kind", () => {
    expect(
      parsePendingCapture({
        kind: "instant-replay",
        id: "ir-1",
        imageDataUrl: TINY_PNG,
        capturedAt: 1,
        tabId: 2,
        viewport: { width: 10, height: 10 },
      }),
    ).toBeNull();
  });
});

describe("resolveInstantReplayForSave", () => {
  it("prefers frozen IR for instant-replay pending", async () => {
    const pending = buildInstantReplayPending(
      {
        id: "ir-1",
        imageDataUrl: TINY_PNG,
        capturedAt: 1,
        tabId: 9,
        viewport: { width: 100, height: 100 },
      },
      { artifact: sampleIrArtifact, evidence: null },
    );
    const liveCollect = vi.fn(async () => {
      throw new Error("should not live-collect when frozen");
    });
    const resolved = await resolveInstantReplayForSave(pending, {
      instantReplayEnabled: true,
      liveCollect,
    });
    expect(resolved.mode).toBe("attach");
    if (resolved.mode === "attach") {
      expect(resolved.required).toBe(true);
      expect(resolved.artifact.coveredMs).toBe(2_000);
    }
    expect(liveCollect).not.toHaveBeenCalled();
  });

  it("optionally live-collects for screenshot kind when IR enabled", async () => {
    const pending: PendingCapture = {
      kind: "screenshot",
      id: "shot-1",
      imageDataUrl: TINY_PNG,
      capturedAt: 1,
      tabId: 3,
      viewport: { width: 10, height: 10 },
    };
    const resolved = await resolveInstantReplayForSave(pending, {
      instantReplayEnabled: true,
      liveCollect: async () => ({
        ok: true,
        artifact: sampleIrArtifact,
        evidence: null,
      }),
    });
    expect(resolved.mode).toBe("attach");
    if (resolved.mode === "attach") {
      expect(resolved.required).toBe(false);
    }
  });
});

describe("toAnnotatePendingView", () => {
  it("strips frozen IR so the editor message stays small", () => {
    const pending = buildInstantReplayPending(
      {
        id: "ir-1",
        imageDataUrl: TINY_PNG,
        capturedAt: 1,
        tabId: 1,
        viewport: { width: 1, height: 1 },
      },
      { artifact: sampleIrArtifact, evidence: null },
    );
    const view = toAnnotatePendingView(pending);
    expect(view.kind).toBe("instant-replay");
    expect(view.imageDataUrl).toBe(TINY_PNG);
    expect(view).not.toHaveProperty("frozenInstantReplay");
  });
});

describe("parsePendingStillView", () => {
  it("accepts IR still without freeze so the editor can show the image", () => {
    const view = parsePendingStillView({
      kind: "instant-replay",
      id: "ir-1",
      imageDataUrl: TINY_PNG,
      capturedAt: 1,
      tabId: 2,
      viewport: { width: 10, height: 10 },
    });
    expect(view?.kind).toBe("instant-replay");
    expect(view?.imageDataUrl).toBe(TINY_PNG);
  });

  it("rejects non-image payloads", () => {
    expect(
      parsePendingStillView({
        kind: "screenshot",
        id: "shot-1",
        imageDataUrl: "not-an-image",
        capturedAt: 1,
        tabId: 2,
        viewport: { width: 10, height: 10 },
      }),
    ).toBeNull();
  });
});

describe("openAnnotateEditorTab", () => {
  it("creates an active editor tab and marks opened", async () => {
    const createTab = vi.fn(async () => ({ windowId: 3 }));
    const focusWindow = vi.fn(async () => undefined);
    const markOpened = vi.fn(async () => undefined);
    await openAnnotateEditorTab(
      createTab,
      focusWindow,
      markOpened,
      () => "chrome-extension://x/annotate/annotate.html",
    );
    expect(createTab).toHaveBeenCalledWith("chrome-extension://x/annotate/annotate.html");
    expect(focusWindow).toHaveBeenCalledWith(3);
    expect(markOpened).toHaveBeenCalled();
  });
});

describe("defaultCaptionForPending", () => {
  it("defaults IR caption when blank", () => {
    const pending = buildInstantReplayPending(
      {
        id: "ir-1",
        imageDataUrl: TINY_PNG,
        capturedAt: 1,
        tabId: 1,
        viewport: { width: 1, height: 1 },
      },
      { artifact: sampleIrArtifact, evidence: null },
    );
    expect(defaultCaptionForPending(pending, "  ")).toBe("Instant Replay capture");
    expect(defaultCaptionForPending(pending, "Bug here")).toBe("Bug here");
  });
});

describe("mergeAnnotatedScreenshot", () => {
  it("keeps the capture's own identity and provenance over the editor's copy", () => {
    const pending: PendingCapture = {
      kind: "screenshot",
      id: "shot-real",
      imageDataUrl: TINY_PNG,
      capturedAt: 1_700_000_000_000,
      url: "https://shop.test/checkout",
      title: "Checkout",
      viewport: { width: 1440, height: 900 },
      tabId: 1,
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
