/**
 * Evidence capture must be re-armed after the recorded tab navigates.
 *
 * On Firefox console/network evidence lives in injected content scripts, which a
 * navigation destroys. The tabs.onUpdated handler used to re-arm only user-event
 * capture and the drawing overlay, so a recording on a reloading dev server ended
 * with empty console.json and "Receiving end does not exist" at stop.
 *
 * Chromium keeps evidence on CDP, which survives navigation, so its runtime must
 * expose the same method as a no-op rather than the service worker branching.
 *
 * Since the EvidenceCollector seam (src/platform/evidence/), the inject/verify/
 * restart logic that used to live on FirefoxRecordingRuntime lives on
 * InPageEvidenceCollector instead; the runtime only owns the stale-session guard
 * and delegates the rest to `this.#evidence.reattach(...)`. These tests read
 * whichever file actually owns each piece of behaviour.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const swSource = readFileSync(resolve(__dirname, "service-worker.ts"), "utf8");
const firefoxRuntime = readFileSync(
  resolve(__dirname, "../platform/recording-runtime/firefox-runtime.ts"),
  "utf8",
);
const chromiumRuntime = readFileSync(
  resolve(__dirname, "../platform/recording-runtime/chromium-runtime.ts"),
  "utf8",
);
const runtimeTypes = readFileSync(
  resolve(__dirname, "../platform/recording-runtime/types.ts"),
  "utf8",
);
const inPageCollector = readFileSync(
  resolve(__dirname, "../platform/evidence/in-page-collector.ts"),
  "utf8",
);

/** The `tabs.onUpdated` listener that keeps a live recording armed. */
function navigationListener(): string {
  const marker = 'if (changeInfo.status === "complete")';
  const start = swSource.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  return swSource.slice(start, start + 700);
}

describe("evidence capture re-arm after navigation", () => {
  it("re-arms all three surfaces on navigation complete", () => {
    const listener = navigationListener();
    expect(listener).toContain("startRecordingEventCapture(tabId");
    expect(listener).toContain("startDrawingOverlay(tabId");
    // The one that used to be missing.
    expect(listener).toContain("recordingRuntime.reinjectEvidenceCapture(tabId");
  });

  it("is part of the runtime contract, not a Firefox-only cast", () => {
    expect(runtimeTypes).toContain("reinjectEvidenceCapture(tabId: number, sessionId: string)");
    expect(firefoxRuntime).toContain("async reinjectEvidenceCapture(");
    expect(chromiumRuntime).toContain("async reinjectEvidenceCapture(");
  });

  it("Firefox re-injects both worlds and restarts capture, ignoring stale sessions", () => {
    // The runtime delegates to the collector's reattach; the "ignoring stale
    // sessions" guard lives on the runtime (it owns #sessionId), the inject-and-
    // restart logic lives on the collector.
    const runtimeReattach = firefoxRuntime.indexOf("async reinjectEvidenceCapture(");
    const runtimeBody = firefoxRuntime.slice(runtimeReattach, runtimeReattach + 300);
    expect(runtimeBody).toContain("sessionId !== this.#sessionId");
    expect(runtimeBody).toContain("this.#evidence.reattach(tabId, sessionId)");

    const collectorReattach = inPageCollector.indexOf("async reattach(");
    const collectorBody = inPageCollector.slice(collectorReattach, collectorReattach + 500);
    expect(collectorBody).toContain("#injectAndVerify(tabId)");
    expect(collectorBody).toContain('type: "START"');
  });

  it("checks the injection outcome instead of trusting a resolved promise", () => {
    // MDN: Firefox can resolve executeScript while the script never ran.
    expect(inPageCollector).toContain("injectScriptFile");
    expect(inPageCollector).not.toMatch(/await chrome\.scripting\.executeScript\(/);
    // Both worlds are injected, and both across all frames — a main-frame-only
    // injection silently omits every iframe's console and network traffic.
    expect(inPageCollector).toContain('world: "ISOLATED"');
    expect(inPageCollector).toContain('world: "MAIN"');
    expect(inPageCollector.match(/allFrames: true/g)?.length).toBeGreaterThanOrEqual(2);
    expect(inPageCollector).toContain("#describeFailure");
  });

  it("fails attach when capture cannot be installed", () => {
    // A silent failure ships a recording whose console.json is empty. The
    // collector reports ok:false; the runtime is the one that turns that into a
    // thrown error for a fresh start (see start() in firefox-runtime.ts).
    const start = inPageCollector.indexOf("#describeFailure(detail: string");
    expect(start).toBeGreaterThan(-1);
    const body = inPageCollector.slice(start, start + 400);
    expect(body).toContain("Grant GN Tracing access to this site");

    const startMethod = firefoxRuntime.indexOf("async start(input: RecordingStartInput)");
    // Anchor on the NEXT method definition rather than a fixed byte window,
    // so an unrelated field or comment added to start() cannot make this test
    // read past its own method body into the next one (or, if the method
    // grows, miss the assertion entirely — both have happened to this file).
    const nextMethod = firefoxRuntime.indexOf("\n  async ", startMethod + 10);
    const startBody = firefoxRuntime.slice(startMethod, nextMethod);
    expect(startBody).toContain("if (!attached.ok)");
    expect(startBody).toContain("throw new Error(");
  });

  it("does not treat a resolved MAIN-world injection as proof it ran in the page", () => {
    // The realm check is the only thing that separates "ran" from "ran in the
    // page realm"; without it a sandboxed or CSP-blocked injection reports success.
    expect(inPageCollector).toContain("#verifyPageRealm(tabId)");
    expect(inPageCollector).toContain('type: "VERIFY_REALM"');
    // The check must gate the success path, not run after it.
    const verifyAt = inPageCollector.indexOf("const realm = await this.#verifyPageRealm(tabId)");
    const returnOkAt = inPageCollector.indexOf("ok: true,", verifyAt);
    expect(verifyAt).toBeGreaterThan(-1);
    expect(returnOkAt).toBeGreaterThan(verifyAt);
  });
});
