/**
 * Structural wiring checks for Instant Replay CDP package + Record hand-off.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { InstantReplayArtifact } from "../../packages/replay-core/src/schema/annotation";
import { buildInstantReplayPackageArtifacts } from "../shared/instant-replay-evidence-package";
import { getPrivacyProfileSettings } from "../shared/privacy-redaction";
import { parseCollectInstantReplayResponse } from "./instant-replay-session";

const swSource = readFileSync(resolve(__dirname, "service-worker.ts"), "utf8");

function sliceFunction(source: string, signature: string): string {
  const re = new RegExp(
    `(?:^|\\n)(${signature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b[\\s\\S]*?)(?=\\nasync function |\\nfunction |$)`,
  );
  const match = re.exec(source);
  expect(match?.[1]).toBeTruthy();
  return match![1];
}

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

describe("Instant Replay CDP wiring", () => {
  it("CAPTURE path packages evidence keys the player reads", () => {
    const collected = parseCollectInstantReplayResponse({
      ok: true,
      artifact: sampleArtifact,
      evidence: {
        console: [{ source: "console-api", level: "log", timestamp: 1, message: "bug" }],
        network: [
          {
            requestId: "n1",
            url: "https://example.com/api",
            method: "GET",
            requestHeaders: null,
            postData: null,
            timestamp: 1,
            wallTime: 1,
            initiator: null,
            resourceType: "fetch",
            status: 500,
            statusText: "ERR",
            responseHeaders: null,
            mimeType: null,
            timing: null,
            protocol: null,
            remoteIPAddress: null,
            encodedDataLength: 0,
            error: "failed",
            responseBody: null,
            redirectChain: null,
          },
        ],
        websocket: [],
        storage: [],
      },
    });
    expect(collected.ok).toBe(true);
    if (!collected.ok) {
      return;
    }

    const artifacts = buildInstantReplayPackageArtifacts({
      instantReplayJson: JSON.stringify(collected.artifact),
      evidence: collected.evidence,
      privacySettings: getPrivacyProfileSettings("standard"),
    });

    expect(Object.keys(artifacts).sort()).toEqual(["console", "instantReplay", "network"].sort());
    expect(Array.isArray(JSON.parse(artifacts.console!))).toBe(true);

    expect(swSource).toContain("buildInstantReplayPackageArtifacts");
    // IR capture freezes lookback + opens annotate; packaging runs on save.
    expect(swSource).toContain("buildInstantReplayPending");
    expect(swSource).toContain("createAnnotateCaptureDeps");
    expect(swSource).toContain("openAnnotateEditorTab");
    expect(swSource).toContain("readPendingStillForAnnotate");
    expect(swSource).toContain("resolveInstantReplayForSave");
    // IR freeze parks in IndexedDB (not session) so lookback can exceed 10MB.
    const reportSource = readFileSync(resolve(__dirname, "screenshot-report.ts"), "utf8");
    expect(reportSource).toContain("putPendingIrFreeze");
    expect(reportSource).toContain("getPendingIrFreeze");
    expect(swSource).toMatch(/artifacts:\s*screenshotArtifacts/);
    // Screenshots never live-collect IR; only frozen IR pending attaches evidence.
    expect(swSource).toContain("resolveInstantReplayForSave(pending)");
    expect(swSource).toContain(
      'packageKind: isInstantReplayReport ? "instant-replay" : "screenshot"',
    );
    // Screenshot path injects a one-shot DOM capture (not IR lookback).
    expect(swSource).toContain("captureTabDomSnapshot");
    expect(swSource).toContain("page-dom-snapshot.js");
    expect(swSource).toContain("createInstantReplayCdpHub");
    expect(swSource).toContain("irCdpHub");
    expect(swSource).toContain("peekEvidenceBundle");
  });

  it("Record coexistence pauses IR CDP and resumes after stop", () => {
    expect(swSource).toContain("pauseInstantReplayEvidence");
    expect(swSource).toContain("resumeInstantReplayEvidence");
    expect(swSource).toContain("pauseForRecording");
    expect(swSource).toContain("resumeAfterRecording");

    const startFn = sliceFunction(swSource, "async function startRecording");
    expect(startFn).toContain("await pauseInstantReplayEvidence(tabId)");
    expect(startFn).toMatch(/catch\s*\(error\)[\s\S]*await resumeInstantReplayEvidence\(tabId\)/);

    const removeFn = sliceFunction(swSource, "async function removeRecording");
    expect(removeFn).toMatch(
      /await resumeInstantReplayEvidence\(recordingTabId\)[\s\S]*return \{ ok: true \}/,
    );
    expect(removeFn).toMatch(
      /catch\s*\(error\)[\s\S]*await resumeInstantReplayEvidence\(recordingTabId\)/,
    );
  });

  it("DOM frames remain required when evidence alone is present", () => {
    const result = parseCollectInstantReplayResponse({
      ok: true,
      artifact: { ...sampleArtifact, frames: [] },
      evidence: {
        console: [{ source: "console-api", level: "log", timestamp: 1, message: "x" }],
        network: [],
        websocket: [],
        storage: [],
      },
    });
    expect(result.ok).toBe(false);
  });
});
