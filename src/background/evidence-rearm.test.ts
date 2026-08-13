/**
 * Evidence capture must be re-armed after the recorded tab navigates.
 *
 * On Firefox console evidence lives in injected content scripts, which a
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
    // reattach arms via #sendStart (START + captureNetwork: false), not inline type.
    expect(collectorBody).toContain("#sendStart(tabId, sessionId)");
  });

  it("checks the injection outcome instead of trusting a resolved promise", () => {
    // MDN: Firefox can resolve executeScript while the script never ran.
    expect(inPageCollector).toContain("injectScriptFile");
    expect(inPageCollector).not.toMatch(/await chrome\.scripting\.executeScript\(/);
    // Both worlds are injected, and both across all frames — a main-frame-only
    // injection silently omits every iframe's console traffic.
    expect(inPageCollector).toContain('world: "ISOLATED"');
    expect(inPageCollector).toContain('world: "MAIN"');
    expect(inPageCollector.match(/allFrames: true/g)?.length).toBeGreaterThanOrEqual(2);
    expect(inPageCollector).toContain("#describeFailure");
  });

  it("fails start when no collector can prepare", () => {
    // A silent failure ships a recording with no evidence. The set reports
    // ok:false only when every collector fails; the runtime turns that into a
    // thrown error for a fresh start.
    const start = inPageCollector.indexOf("#describeFailure(detail: string");
    expect(start).toBeGreaterThan(-1);
    const body = inPageCollector.slice(start, start + 400);
    expect(body).toContain("Grant GN Tracing access to this site");

    const startMethod = firefoxRuntime.indexOf("async start(input: RecordingStartInput)");
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

  it("Firefox start prepares before media and arms START only after media commit", () => {
    const startMethod = firefoxRuntime.indexOf("async start(input: RecordingStartInput)");
    const nextMethod = firefoxRuntime.indexOf("\n  async ", startMethod + 10);
    const startBody = firefoxRuntime.slice(startMethod, nextMethod);

    const attachAt = startBody.indexOf("this.#evidence.attach(");
    const mediaAt = startBody.indexOf("this.#media.startCapture(");
    const beginAt = startBody.indexOf("this.#evidence.beginSession(");
    expect(attachAt).toBeGreaterThan(-1);
    expect(mediaAt).toBeGreaterThan(attachAt);
    expect(beginAt).toBeGreaterThan(mediaAt);

    // attach must not START; beginSession / reattach own START.
    const attachMethod = inPageCollector.indexOf("async attach(");
    const beginMethod = inPageCollector.indexOf("async beginSession(");
    const attachBody = inPageCollector.slice(attachMethod, beginMethod);
    expect(attachBody).not.toContain('type: "START"');
    // beginSession is longer (re-inject recovery); look at a wider window.
    expect(inPageCollector.slice(beginMethod, beginMethod + 1200)).toContain("#sendStart");
    expect(inPageCollector.slice(beginMethod, beginMethod + 1200)).toContain("#injectAndVerify");
  });

  it("Chromium starts media before CDP attach so evidence cannot precede video t=0", () => {
    const startMethod = chromiumRuntime.indexOf("async start(input: RecordingStartInput)");
    const nextMethod = chromiumRuntime.indexOf("\n  stopMedia", startMethod);
    const startBody = chromiumRuntime.slice(
      startMethod,
      nextMethod === -1 ? undefined : nextMethod,
    );

    const mediaAt = startBody.indexOf("this.#media.startCapture(");
    const attachAt = startBody.indexOf("this.#evidence.attach(");
    expect(mediaAt).toBeGreaterThan(-1);
    expect(attachAt).toBeGreaterThan(mediaAt);
    expect(startBody).not.toMatch(/Promise\.all\(\s*\[/);
  });

  it("full-record START disables page-script network capture", () => {
    expect(inPageCollector).toContain("captureNetwork: false");
    expect(inPageCollector).not.toMatch(/responseBodyMode:\s*input/);
    // provides is console+websocket only — no network-bodies capability claim.
    expect(inPageCollector).toMatch(
      /IN_PAGE_CAPABILITIES[^=]*=\s*\[?\s*"console",\s*"websocket"\s*\]/,
    );
    expect(inPageCollector).not.toMatch(/capabilities\.push\(\s*"network-bodies"/);
  });
});
