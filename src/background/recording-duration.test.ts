/**
 * Packaged duration must share the firstFrameAt wall origin with evidence.
 * A later service-worker performance.now() interval made the bar disagree
 * with video.currentTime and with the live popup timer.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const swSource = readFileSync(resolve(__dirname, "service-worker.ts"), "utf8");
const offscreenSource = readFileSync(resolve(__dirname, "../offscreen/offscreen.ts"), "utf8");

describe("recording duration clock", () => {
  it("packages duration from startTime to stopTime, not a post-start monotonic clock", () => {
    expect(swSource).not.toContain("activeRecordingStartMonotonicMs");
    expect(swSource).toContain("const durationMs = getElapsedMs(stopTime)");
    expect(swSource).toContain("activeRecording.startTime = firstFrameAt ?? Date.now()");
  });

  it("falls back to MediaRecorder.start() when the first-frame wait times out", () => {
    expect(offscreenSource).toContain("const startedAt = Date.now()");
    expect(offscreenSource).toContain("return (await waitForFirstFrame(stream)) ?? startedAt");
  });
});
