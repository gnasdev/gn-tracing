/**
 * Unit tests for shipped Instant Replay pure policies.
 */
import { describe, expect, it } from "vitest";
import type { InstantReplayArtifact } from "../../packages/replay-core/src/schema/annotation";
import {
  allowHardFullBufferPurgeInterval,
  buildReportUploadHistoryEntry,
  COLLECT_INSTANT_REPLAY_ACTION,
  COMMIT_INSTANT_REPLAY_ACTION,
  hasInstantReplayFrames,
  mapInstantReplayToDomArtifact,
  packageHasInspectableDom,
  resolveDomArtifactForPlayer,
  shouldClearBufferOnAction,
  shouldClearBufferOnCollect,
} from "./instant-replay-policy";

const sampleArtifact: InstantReplayArtifact = {
  schemaVersion: 1,
  windowMs: 180_000,
  coveredMs: 5_000,
  droppedFrames: 0,
  frames: [
    {
      capturedAt: 1_000,
      relativeMs: 0,
      documentUrl: "https://example.com/a",
      viewport: { width: 1280, height: 720 },
      root: {
        nodeType: 1,
        nodeName: "HTML",
        children: [
          {
            nodeType: 1,
            nodeName: "BODY",
            children: [{ nodeType: 3, nodeName: "#text", nodeValue: "hello-frame-0" }],
          },
        ],
      },
    },
    {
      capturedAt: 3_500,
      relativeMs: 2_500,
      documentUrl: "https://example.com/b",
      viewport: { width: 1280, height: 720 },
      root: {
        nodeType: 1,
        nodeName: "HTML",
        children: [
          {
            nodeType: 1,
            nodeName: "BODY",
            children: [{ nodeType: 3, nodeName: "#text", nodeValue: "hello-frame-1" }],
          },
        ],
      },
    },
  ],
};

describe("buffer handoff policy", () => {
  it("never clears on collect — only on explicit commit", () => {
    expect(shouldClearBufferOnCollect()).toBe(false);
    expect(shouldClearBufferOnAction(COLLECT_INSTANT_REPLAY_ACTION)).toBe(false);
    expect(shouldClearBufferOnAction(COMMIT_INSTANT_REPLAY_ACTION)).toBe(true);
    expect(shouldClearBufferOnAction("OTHER")).toBe(false);
  });
});

describe("retention / hard purge policy", () => {
  it("rejects a 120s full wipe when the configured window is longer", () => {
    expect(allowHardFullBufferPurgeInterval(300_000, 120_000)).toBe(false);
    expect(allowHardFullBufferPurgeInterval(180_000, 120_000)).toBe(false);
  });

  it("allows a purge cadence at least as long as the window", () => {
    expect(allowHardFullBufferPurgeInterval(60_000, 60_000)).toBe(true);
    expect(allowHardFullBufferPurgeInterval(120_000, 120_000)).toBe(true);
    expect(allowHardFullBufferPurgeInterval(60_000, 180_000)).toBe(true);
  });
});

describe("mapInstantReplayToDomArtifact", () => {
  it("exposes every frame root for Elements inspection", () => {
    const dom = mapInstantReplayToDomArtifact(sampleArtifact);
    expect(dom.schemaVersion).toBe(1);
    expect(dom.snapshots).toHaveLength(2);
    expect(dom.snapshots[0].label).toMatch(/instant-replay:\+0s/);
    expect(dom.snapshots[1].label).toMatch(/instant-replay:\+2\.5s/);
    expect(JSON.stringify(dom.snapshots[0].root)).toContain("hello-frame-0");
    expect(JSON.stringify(dom.snapshots[1].root)).toContain("hello-frame-1");
    expect(dom.snapshots[0].documentUrl).toBe("https://example.com/a");
  });
});

describe("resolveDomArtifactForPlayer", () => {
  it("uses IR frames when dom.json is absent", () => {
    const resolved = resolveDomArtifactForPlayer({ instantReplay: sampleArtifact });
    expect(resolved?.snapshots).toHaveLength(2);
    expect(packageHasInspectableDom({ instantReplay: sampleArtifact })).toBe(true);
  });

  it("merges IR frames ahead of classic dom snapshots", () => {
    const resolved = resolveDomArtifactForPlayer({
      instantReplay: sampleArtifact,
      dom: {
        schemaVersion: 1,
        snapshots: [
          {
            label: "stop",
            capturedAt: 9_000,
            documentUrl: "https://example.com",
            root: { nodeType: 9, nodeName: "#document" },
          },
        ],
      },
    });
    expect(resolved?.snapshots).toHaveLength(3);
    expect(resolved?.snapshots[0].label).toMatch(/instant-replay/);
    expect(resolved?.snapshots[2].label).toBe("stop");
  });

  it("returns null when neither source has snapshots", () => {
    expect(resolveDomArtifactForPlayer({})).toBeNull();
    expect(hasInstantReplayFrames({ ...sampleArtifact, frames: [] })).toBe(false);
  });
});

describe("buildReportUploadHistoryEntry", () => {
  it("records a usable replay URL for IR/screenshot uploads", () => {
    const entry = buildReportUploadHistoryEntry({
      recordingUrl: "https://tracing.example/r/abc",
      pageUrl: "https://app.example/bug",
      indexFileId: "file-1",
      targetFolderId: "folder-9",
      durationMs: 45_000,
      provider: "google-drive",
      uploadedAt: 1_700_000_000_000,
    });
    expect(entry.recordingUrl).toBe("https://tracing.example/r/abc");
    expect(entry.pageUrl).toBe("https://app.example/bug");
    expect(entry.provider).toBe("google-drive");
    expect(entry.durationMs).toBe(45_000);
    expect(entry.id).toContain("file-1");
    expect(entry.uploadedAt).toBe(1_700_000_000_000);
  });
});
