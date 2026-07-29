/**
 * IndexedDB-backed IR freeze store (uses in-memory fallback under Node/vitest).
 */
import { afterEach, describe, expect, it } from "vitest";
import type { InstantReplayArtifact } from "../../packages/replay-core/src/schema/annotation";
import {
  clearPendingIrFreeze,
  getPendingIrFreeze,
  putPendingIrFreeze,
  resetPendingIrFreezeMemoryForTests,
} from "./pending-ir-freeze-idb";

const sampleArtifact: InstantReplayArtifact = {
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

afterEach(() => {
  resetPendingIrFreezeMemoryForTests();
});

describe("pending-ir-freeze-idb", () => {
  it("round-trips freeze by pending id", async () => {
    await putPendingIrFreeze("ir-1", {
      artifact: sampleArtifact,
      evidence: { console: [], network: [], websocket: [], storage: [] },
    });
    const loaded = await getPendingIrFreeze("ir-1");
    expect(loaded?.artifact.coveredMs).toBe(2_000);
    expect(loaded?.evidence).toEqual({
      console: [],
      network: [],
      websocket: [],
      storage: [],
    });
  });

  it("rejects empty lookback", async () => {
    await expect(
      putPendingIrFreeze("ir-empty", {
        artifact: { ...sampleArtifact, frames: [] },
        evidence: null,
      }),
    ).rejects.toThrow(/invalid|freeze/i);
  });

  it("clears by id and returns null after clear", async () => {
    await putPendingIrFreeze("ir-2", { artifact: sampleArtifact, evidence: null });
    await clearPendingIrFreeze("ir-2");
    expect(await getPendingIrFreeze("ir-2")).toBeNull();
  });

  it("clear-all removes every parked freeze", async () => {
    await putPendingIrFreeze("a", { artifact: sampleArtifact, evidence: null });
    await putPendingIrFreeze("b", { artifact: sampleArtifact, evidence: null });
    await clearPendingIrFreeze();
    expect(await getPendingIrFreeze("a")).toBeNull();
    expect(await getPendingIrFreeze("b")).toBeNull();
  });
});
