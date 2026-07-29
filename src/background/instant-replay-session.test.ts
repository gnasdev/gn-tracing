/**
 * Unit tests for Instant Replay collect helpers (always-on buffer path).
 */
import { describe, expect, it } from "vitest";
import type { InstantReplayArtifact } from "../../packages/replay-core/src/schema/annotation";
import {
  hasInstantReplayFrames,
  parseCollectInstantReplayResponse,
  withMainWorldEvidenceFallback,
} from "./instant-replay-session";

const sampleArtifact: InstantReplayArtifact = {
  schemaVersion: 1,
  windowMs: 120_000,
  coveredMs: 5_000,
  droppedFrames: 0,
  frames: [
    {
      capturedAt: 1_000,
      relativeMs: 0,
      documentUrl: "https://example.com",
      viewport: { width: 1280, height: 720 },
      root: { nodeType: 9, nodeName: "#document" },
    },
  ],
};

describe("hasInstantReplayFrames", () => {
  it("is true only when frames are present", () => {
    expect(hasInstantReplayFrames(sampleArtifact)).toBe(true);
    expect(hasInstantReplayFrames({ ...sampleArtifact, frames: [] })).toBe(false);
    expect(hasInstantReplayFrames(null)).toBe(false);
    expect(hasInstantReplayFrames(undefined)).toBe(false);
  });
});

describe("parseCollectInstantReplayResponse", () => {
  it("accepts a valid artifact response", () => {
    const result = parseCollectInstantReplayResponse({
      ok: true,
      artifact: sampleArtifact,
      disabledReason: null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.artifact.frames).toHaveLength(1);
      expect(result.disabledReason).toBeNull();
      // Missing evidence field is best-effort null (DOM-only package still ok).
      expect(result.evidence).toBeNull();
    }
  });

  it("keeps DOM success when evidence is present", () => {
    const result = parseCollectInstantReplayResponse({
      ok: true,
      artifact: sampleArtifact,
      evidence: {
        console: [{ source: "console-api", level: "log", timestamp: 1, message: "x" }],
        network: [],
        websocket: [],
        storage: [],
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.evidence?.console).toHaveLength(1);
    }
  });

  it("rejects empty buffer with a clear error", () => {
    const result = parseCollectInstantReplayResponse({
      ok: true,
      artifact: { ...sampleArtifact, frames: [] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/No Instant Replay lookback/i);
    }
  });

  it("surfaces disabledReason when the recorder stopped itself", () => {
    const result = parseCollectInstantReplayResponse({
      ok: true,
      artifact: null,
      disabledReason: "DOM snapshots took over 50ms 3 times in a row",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/50ms/);
      expect(result.disabledReason).toMatch(/50ms/);
    }
  });

  it("handles missing content-script response", () => {
    const result = parseCollectInstantReplayResponse(undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/not running/i);
    }
  });
});

describe("withMainWorldEvidenceFallback", () => {
  it("fills empty bridge evidence from MAIN executeScript JSON", () => {
    const collected = parseCollectInstantReplayResponse({
      ok: true,
      artifact: sampleArtifact,
      evidence: null,
    });
    expect(collected.ok).toBe(true);
    if (!collected.ok) {
      return;
    }

    const merged = withMainWorldEvidenceFallback(
      collected,
      JSON.stringify({
        console: [
          {
            source: "console-api",
            level: "error",
            timestamp: Date.now(),
            message: "ir-bug",
          },
        ],
        network: [],
        websocket: [],
        storage: [],
      }),
    );
    expect(merged.ok).toBe(true);
    if (merged.ok) {
      expect(merged.evidence?.console?.[0]?.message).toBe("ir-bug");
    }
  });

  it("keeps longer console ring when both bridge and MAIN have rows", () => {
    const collected = parseCollectInstantReplayResponse({
      ok: true,
      artifact: sampleArtifact,
      evidence: {
        console: [{ source: "console-api", level: "log", timestamp: 1, message: "keep" }],
        network: [],
        websocket: [],
        storage: [],
      },
    });
    expect(collected.ok).toBe(true);
    if (!collected.ok) {
      return;
    }

    // Same length → primary wins.
    const sameLen = withMainWorldEvidenceFallback(
      collected,
      JSON.stringify({
        console: [{ source: "console-api", level: "log", timestamp: 2, message: "other" }],
        network: [],
        websocket: [],
        storage: [],
      }),
    );
    expect(sameLen.ok && sameLen.evidence?.console?.[0]?.message).toBe("keep");

    // MAIN has more rows → prefer MAIN console.
    const richer = withMainWorldEvidenceFallback(
      collected,
      JSON.stringify({
        console: [
          { source: "console-api", level: "log", timestamp: 2, message: "a" },
          { source: "console-api", level: "log", timestamp: 3, message: "b" },
        ],
        network: [],
        websocket: [],
        storage: [],
      }),
    );
    expect(richer.ok && richer.evidence?.console).toHaveLength(2);
  });

  it("pulls MAIN console even when bridge only returned storage", () => {
    const collected = parseCollectInstantReplayResponse({
      ok: true,
      artifact: sampleArtifact,
      evidence: {
        console: [],
        network: [],
        websocket: [],
        storage: [
          {
            phase: "stop",
            capturedAt: 1,
            localStorage: [],
            sessionStorage: [],
            cookies: [],
          },
        ],
      },
    });
    expect(collected.ok).toBe(true);
    if (!collected.ok) {
      return;
    }
    const merged = withMainWorldEvidenceFallback(
      collected,
      JSON.stringify({
        console: [{ source: "console-api", level: "error", timestamp: 9, message: "ir-bug" }],
        network: [],
        websocket: [],
        storage: [],
      }),
    );
    expect(merged.ok).toBe(true);
    if (merged.ok) {
      expect(merged.evidence?.console?.[0]?.message).toBe("ir-bug");
      expect(merged.evidence?.storage).toHaveLength(1);
    }
  });

  it("ignores invalid MAIN JSON without failing the collect", () => {
    const collected = parseCollectInstantReplayResponse({
      ok: true,
      artifact: sampleArtifact,
    });
    expect(collected.ok).toBe(true);
    if (!collected.ok) {
      return;
    }
    const merged = withMainWorldEvidenceFallback(collected, "{not-json");
    expect(merged.ok).toBe(true);
    if (merged.ok) {
      expect(merged.evidence).toBeNull();
    }
  });
});
