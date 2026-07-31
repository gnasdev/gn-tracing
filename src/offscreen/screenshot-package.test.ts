/**
 * End-to-end coverage of the screenshot-report path the user actually walks:
 * capture → annotate (arrow / box / note / caption / redact) → package still only
 * (no Instant Replay lookback, no console/network).
 *
 * OffscreenCanvas is unavailable under Node, so redaction baking is stubbed to
 * mark shapes applied the same way the real baker does — the guard that refuses
 * unbaked redacts is still exercised against the real package writer.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as raster from "../../packages/replay-core/src/annotate/raster";
import { openRecordingPackageFromBytes } from "../../packages/replay-core/src/artifacts";
import type {
  InstantReplayArtifact,
  Screenshot,
  ScreenshotArtifact,
} from "../../packages/replay-core/src/schema/annotation";
import { screenshotHasUnbakedRedactions } from "../../packages/replay-core/src/schema/annotation";
import { encodeJsonArtifact } from "../../packages/replay-core/src/write";
import { concatChunks } from "../../packages/replay-core/src/write/zip-writer";
import { assertReadyToSave, createShape, EditorHistory } from "../annotate/editor-model";
import {
  type CaptureDeps,
  captureScreenshotForAnnotation,
  mergeAnnotatedScreenshot,
  type PendingScreenshot,
} from "../background/screenshot-report";
import {
  buildScreenshotPackage,
  INSTANT_REPLAY_REPORT_CAPABILITIES,
  SCREENSHOT_REPORT_CAPABILITIES,
} from "./screenshot-package";

/** 1×1 PNG — valid enough for packaging when bake is stubbed. */
const PNG_1X1_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_1X1 = Uint8Array.from(atob(PNG_1X1_B64), (c) => c.charCodeAt(0));
const PNG_DATA_URL = `data:image/png;base64,${PNG_1X1_B64}`;
const CAPTION = "What is wrong here?";
const RED = "#ff3b30";

function createCaptureDeps(): CaptureDeps & {
  pending: PendingScreenshot | null;
} {
  const state = { pending: null as PendingScreenshot | null };
  return {
    captureVisibleTab: vi.fn(async () => PNG_DATA_URL),
    getTab: vi.fn(async () => ({
      windowId: 1,
      url: "https://shop.test/checkout",
      title: "Checkout",
    })),
    getViewport: vi.fn(async () => ({ width: 1440, height: 900, devicePixelRatio: 2 })),
    setPending: vi.fn(async (pending: PendingScreenshot) => {
      state.pending = pending;
    }),
    openEditor: vi.fn(async () => undefined),
    get pending() {
      return state.pending;
    },
  };
}

function drawReporterAnnotations(history: EditorHistory): void {
  const arrow = createShape({
    tool: "arrow",
    from: { x: 0.2, y: 0.3 },
    to: { x: 0.55, y: 0.45 },
    color: RED,
  });
  const box = createShape({
    tool: "rect",
    from: { x: 0.5, y: 0.4 },
    to: { x: 0.75, y: 0.6 },
    color: RED,
  });
  const note = createShape({
    tool: "text",
    from: { x: 0.52, y: 0.35 },
    to: { x: 0.52, y: 0.35 },
    color: RED,
    text: "Total does not match cart",
  });
  const redact = createShape({
    tool: "redact",
    from: { x: 0.05, y: 0.05 },
    to: { x: 0.25, y: 0.12 },
    color: RED,
  });

  expect(arrow?.type).toBe("arrow");
  expect(box?.type).toBe("rect");
  expect(note?.type).toBe("text");
  expect(redact).toMatchObject({ type: "redact", applied: "pending" });

  for (const shape of [arrow, box, note, redact]) {
    if (shape) {
      history.add(shape);
    }
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("annotate → save & package (full reporter flow)", () => {
  it("captures, annotates (arrow/box/note/caption/redact), and packages still + optional DOM", async () => {
    vi.spyOn(raster, "bakeRedactions").mockImplementation(async (bytes, mimeType, screenshot) => {
      for (const annotation of screenshot.annotations) {
        if (annotation.type === "redact" && annotation.applied === "pending") {
          annotation.applied = "blur";
        }
      }
      return { bytes, mimeType, applied: 1 };
    });

    const deps = createCaptureDeps();
    const capture = await captureScreenshotForAnnotation(42, deps);
    expect(capture).toMatchObject({ ok: true });
    expect(deps.pending).not.toBeNull();
    const pending = deps.pending as PendingScreenshot;
    expect(pending.tabId).toBe(42);
    expect(pending.url).toBe("https://shop.test/checkout");

    const history = new EditorHistory();
    drawReporterAnnotations(history);
    expect(history.annotations).toHaveLength(4);

    // Pending redacts must not ship; baking (stubbed) clears them first.
    expect(() => assertReadyToSave(history.annotations)).toThrow(/still readable/i);

    const fromEditor: Screenshot = {
      id: "editor-spoof",
      capturedAt: 0,
      url: "https://evil.test",
      viewport: { width: 1, height: 1 },
      source: { kind: "image", path: "", mimeType: "image/png" },
      annotations: history.annotations,
      caption: CAPTION,
    };

    const merged = mergeAnnotatedScreenshot(pending, fromEditor);
    expect(merged.screenshot.id).toBe(pending.id);
    expect(merged.screenshot.url).toBe("https://shop.test/checkout");
    expect(merged.screenshot.caption).toBe(CAPTION);
    expect(merged.screenshot.annotations.map((a) => a.type).sort()).toEqual([
      "arrow",
      "rect",
      "redact",
      "text",
    ]);

    // One-shot DOM ships; IR lookback + console/network must not.
    const consoleArtifact = {
      schemaVersion: 1,
      entries: [{ level: "warn", message: "price mismatch", timestamp: pending.capturedAt }],
    };
    const networkArtifact = {
      schemaVersion: 1,
      entries: [
        {
          method: "POST",
          url: "https://shop.test/api/checkout",
          status: 200,
          timestamp: pending.capturedAt,
        },
      ],
    };
    const instantReplay: InstantReplayArtifact = {
      schemaVersion: 1,
      windowMs: 120_000,
      coveredMs: 8_000,
      droppedFrames: 0,
      frames: [
        {
          capturedAt: pending.capturedAt - 8_000,
          relativeMs: 0,
          documentUrl: "https://shop.test/checkout",
          viewport: { width: 1440, height: 900 },
          root: { nodeType: 1, nodeName: "HTML" },
        },
      ],
    };
    const domArtifact = {
      schemaVersion: 1,
      snapshots: [
        {
          label: "screenshot",
          capturedAt: pending.capturedAt,
          documentUrl: "https://shop.test/checkout",
          root: {
            nodeType: 1,
            nodeName: "HTML",
            children: [
              {
                nodeType: 1,
                nodeName: "BODY",
                children: [{ nodeType: 3, nodeName: "#text", nodeValue: "checkout-root" }],
              },
            ],
          },
        },
      ],
    };

    const built = await buildScreenshotPackage({
      screenshots: [
        {
          screenshot: merged.screenshot,
          imageBytes: PNG_1X1,
          imageMimeType: "image/png",
        },
      ],
      packagedAt: "2026-07-27T00:00:00.000Z",
      zipFilename: "gn-tracing-screenshot-report.zip",
      url: merged.screenshot.url,
      packageKind: "screenshot",
      artifacts: {
        console: encodeJsonArtifact(consoleArtifact),
        network: encodeJsonArtifact(networkArtifact),
        instantReplay: encodeJsonArtifact(instantReplay),
        dom: encodeJsonArtifact(domArtifact),
      },
      modifiedAt: new Date(0),
    });

    expect(SCREENSHOT_REPORT_CAPABILITIES).toEqual(["screenshot", "annotation"]);
    expect(screenshotHasUnbakedRedactions(merged.screenshot)).toBe(false);

    const pkg = await openRecordingPackageFromBytes(concatChunks(built.chunks));
    expect(pkg.metadata.producer).toBe("extension");
    expect(pkg.metadata.capabilities).toEqual(["screenshot", "annotation", "dom-snapshot"]);
    expect(pkg.metadata.url).toBe("https://shop.test/checkout");

    expect(pkg.hasArtifact("screenshots")).toBe(true);
    expect(pkg.hasArtifact("dom")).toBe(true);
    expect(pkg.hasArtifact("instantReplay")).toBe(false);
    expect(pkg.hasArtifact("console")).toBe(false);
    expect(pkg.hasArtifact("network")).toBe(false);
    expect(pkg.hasArtifact("video")).toBe(false);

    const domRead = await pkg.readArtifact<{ snapshots: Array<{ root: unknown }> }>("dom");
    expect(JSON.stringify(domRead?.snapshots[0]?.root)).toContain("checkout-root");

    const shots = await pkg.readArtifact<ScreenshotArtifact>("screenshots");
    expect(shots?.screenshots).toHaveLength(1);
    const shot = shots?.screenshots[0];
    expect(shot?.caption).toBe(CAPTION);
    expect(shot?.annotations).toHaveLength(4);
    expect(shot?.annotations.find((a) => a.type === "text")).toMatchObject({
      text: "Total does not match cart",
    });
    expect(shot?.annotations.find((a) => a.type === "redact")).toMatchObject({
      applied: "blur",
    });
    expect(shot?.source.kind).toBe("image");
    if (shot?.source.kind === "image") {
      expect(shot.source.path).toMatch(/^screenshots\/.+\.png$/);
      const imageBytes = await pkg.readEntryBytes(shot.source.path);
      expect(imageBytes.byteLength).toBeGreaterThan(0);
    }

    expect(raster.bakeRedactions).toHaveBeenCalledOnce();
  });

  it("Instant Replay packageKind keeps console/network and claims log capabilities", async () => {
    const instantReplay: InstantReplayArtifact = {
      schemaVersion: 1,
      windowMs: 120_000,
      coveredMs: 3_000,
      droppedFrames: 0,
      frames: [
        {
          capturedAt: 1,
          relativeMs: 0,
          documentUrl: "https://app.test/ir",
          viewport: { width: 800, height: 600 },
          root: { nodeType: 1, nodeName: "HTML" },
        },
      ],
    };
    const consoleArtifact = [{ level: "error", message: "boom", timestamp: 1 }];
    const networkArtifact = {
      schemaVersion: 2,
      entries: [{ method: "GET", url: "https://app.test/api", status: 500, timestamp: 1 }],
    };

    const built = await buildScreenshotPackage({
      screenshots: [],
      packagedAt: "2026-07-27T00:00:00.000Z",
      zipFilename: "gn-tracing-ir-report.zip",
      url: "https://app.test/ir",
      packageKind: "instant-replay",
      artifacts: {
        instantReplay: encodeJsonArtifact(instantReplay),
        console: encodeJsonArtifact(consoleArtifact),
        network: encodeJsonArtifact(networkArtifact),
      },
      modifiedAt: new Date(0),
    });

    const pkg = await openRecordingPackageFromBytes(concatChunks(built.chunks));
    expect(pkg.metadata.capabilities).toEqual(
      expect.arrayContaining(INSTANT_REPLAY_REPORT_CAPABILITIES),
    );
    expect(pkg.metadata.capabilities).toContain("console");
    expect(pkg.metadata.capabilities).toContain("network");
    expect(pkg.hasArtifact("instantReplay")).toBe(true);
    expect(pkg.hasArtifact("console")).toBe(true);
    expect(pkg.hasArtifact("network")).toBe(true);
  });

  it("packages without console/network/instant-replay when those artifacts are absent", async () => {
    const history = new EditorHistory();
    const arrow = createShape({
      tool: "arrow",
      from: { x: 0.1, y: 0.1 },
      to: { x: 0.4, y: 0.4 },
      color: RED,
    });
    if (arrow) {
      history.add(arrow);
    }
    assertReadyToSave(history.annotations);

    const screenshot: Screenshot = {
      id: "shot-lean",
      capturedAt: 1_700_000_000_000,
      url: "https://app.test/",
      viewport: { width: 1280, height: 800 },
      source: { kind: "image", path: "", mimeType: "image/png" },
      annotations: history.annotations,
      caption: CAPTION,
    };

    const built = await buildScreenshotPackage({
      screenshots: [{ screenshot, imageBytes: PNG_1X1, imageMimeType: "image/png" }],
      packagedAt: "2026-07-27T00:00:00.000Z",
      zipFilename: "gn-tracing-lean.zip",
      url: screenshot.url,
      modifiedAt: new Date(0),
    });

    const pkg = await openRecordingPackageFromBytes(concatChunks(built.chunks));
    expect(pkg.hasArtifact("screenshots")).toBe(true);
    expect(pkg.hasArtifact("console")).toBe(false);
    expect(pkg.hasArtifact("network")).toBe(false);
    expect(pkg.hasArtifact("instantReplay")).toBe(false);
    expect(pkg.metadata.capabilities).toEqual(["screenshot", "annotation"]);
    expect(pkg.metadata.capabilities).not.toContain("console");
    expect(pkg.metadata.capabilities).not.toContain("network");
    expect(pkg.metadata.capabilities).not.toContain("instant-replay");
    expect(pkg.metadata.capabilities).not.toContain("dom-snapshot");

    const shots = await pkg.readArtifact<ScreenshotArtifact>("screenshots");
    expect(shots?.screenshots[0]?.caption).toBe(CAPTION);
    expect(shots?.screenshots[0]?.annotations[0]?.type).toBe("arrow");
  });

  it("packages Instant Replay lookback without a raster still", async () => {
    const instantReplay: InstantReplayArtifact = {
      schemaVersion: 1,
      windowMs: 180_000,
      coveredMs: 4_000,
      droppedFrames: 1,
      frames: [
        {
          capturedAt: 1_700_000_000_000,
          relativeMs: 0,
          documentUrl: "https://app.test/ir",
          viewport: { width: 800, height: 600 },
          root: {
            nodeType: 1,
            nodeName: "HTML",
            children: [
              {
                nodeType: 1,
                nodeName: "BODY",
                children: [{ nodeType: 3, nodeName: "#text", nodeValue: "lookback-root" }],
              },
            ],
          },
        },
      ],
    };

    const built = await buildScreenshotPackage({
      screenshots: [],
      packagedAt: "2026-07-27T00:00:00.000Z",
      zipFilename: "gn-tracing-ir-only.zip",
      url: "https://app.test/ir",
      packageKind: "instant-replay",
      artifacts: {
        instantReplay: encodeJsonArtifact(instantReplay),
      },
      modifiedAt: new Date(0),
    });

    const pkg = await openRecordingPackageFromBytes(concatChunks(built.chunks));
    expect(pkg.hasArtifact("instantReplay")).toBe(true);
    expect(pkg.hasArtifact("video")).toBe(false);
    expect(pkg.hasArtifact("console")).toBe(false);
    // Quiet window still claims log surfaces so the player keeps empty tabs.
    expect(pkg.metadata.capabilities).toEqual(
      expect.arrayContaining(["instant-replay", "console", "network"]),
    );
    const replay = await pkg.readArtifact<InstantReplayArtifact>("instantReplay");
    expect(replay?.frames).toHaveLength(1);
    expect(JSON.stringify(replay?.frames[0].root)).toContain("lookback-root");
  });

  it("refuses to package a screenshot whose redaction is still pending and unbakeable", async () => {
    vi.spyOn(raster, "bakeRedactions").mockImplementation(async (bytes, mimeType) => ({
      bytes,
      mimeType,
      applied: 0,
    }));

    const redact = createShape({
      tool: "redact",
      from: { x: 0.1, y: 0.1 },
      to: { x: 0.3, y: 0.2 },
      color: RED,
    });
    expect(redact).toMatchObject({ type: "redact", applied: "pending" });

    const screenshot: Screenshot = {
      id: "shot-leak",
      capturedAt: 1,
      viewport: { width: 100, height: 100 },
      source: { kind: "image", path: "", mimeType: "image/png" },
      annotations: redact ? [redact] : [],
    };

    await expect(
      buildScreenshotPackage({
        screenshots: [{ screenshot, imageBytes: PNG_1X1, imageMimeType: "image/png" }],
        packagedAt: "2026-07-27T00:00:00.000Z",
        zipFilename: "gn-tracing-leak.zip",
        modifiedAt: new Date(0),
      }),
    ).rejects.toThrow(/unapplied redaction|still readable|Refusing/i);
  });
});
