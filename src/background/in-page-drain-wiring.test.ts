/**
 * Structural proof that stop/drain keeps accepting in-page bridge entries.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const swSource = readFileSync(resolve(import.meta.dirname, "service-worker.ts"), "utf8");

describe("service-worker in-page stop drain wiring", () => {
  it("imports shouldAcceptInPageEntry for the bridge gate", () => {
    expect(swSource).toMatch(/shouldAcceptInPageEntry/);
    expect(swSource).toMatch(/from ["']\.\.\/shared\/in-page-entry-gate["']/);
  });

  it("sets inPageDrainSessionId before clearing isRecording on stop", () => {
    // Prefer the stopRecording assignment order over other isRecording=false sites.
    const stopIdx = swSource.indexOf("async function stopRecording():");
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    const nextFn = swSource.indexOf("\nasync function ", stopIdx + 1);
    const body = swSource.slice(stopIdx, nextFn > stopIdx ? nextFn : undefined);
    const drainIdx = body.indexOf("inPageDrainSessionId = sessionId");
    const isRecordingFalseIdx = body.indexOf("isRecording = false");
    expect(drainIdx).toBeGreaterThanOrEqual(0);
    expect(isRecordingFalseIdx).toBeGreaterThan(drainIdx);
  });

  it("clears drain session after waitForInPageDrain", () => {
    expect(swSource).toMatch(
      /await waitForInPageDrain\(\);\s*\n\s*activeRecording\.inPageDrainSessionId = null/,
    );
  });

  it("passes drainSessionId into shouldAcceptInPageEntry", () => {
    expect(swSource).toMatch(/drainSessionId:\s*activeRecording\.inPageDrainSessionId/);
  });
});
