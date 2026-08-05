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
    const start = firefoxRuntime.indexOf("async reinjectEvidenceCapture(");
    const body = firefoxRuntime.slice(start, start + 900);
    expect(body).toContain("sessionId !== this.#sessionId");
    expect(body).toContain("#injectInPageCapture(tabId");
    expect(body).toContain('type: "START"');
  });

  it("checks the injection outcome instead of trusting a resolved promise", () => {
    // MDN: Firefox can resolve executeScript while the script never ran.
    expect(firefoxRuntime).toContain("injectScriptFile");
    expect(firefoxRuntime).not.toMatch(/await chrome\.scripting\.executeScript\(/);
    // Both worlds are injected, and both across all frames — a main-frame-only
    // injection silently omits every iframe's console and network traffic.
    expect(firefoxRuntime).toContain('world: "ISOLATED"');
    expect(firefoxRuntime).toContain('world: "MAIN"');
    expect(firefoxRuntime.match(/allFrames: true/g)?.length).toBeGreaterThanOrEqual(2);
    expect(firefoxRuntime).toContain("#reportInjectionFailure");
  });

  it("fails the recording start when capture cannot be installed", () => {
    // A silent failure ships a recording whose console.json is empty.
    // Anchor on the method DEFINITION, not the first mention: call sites appear
    // earlier in the file and a fixed-size window from those misses the body.
    const start = firefoxRuntime.indexOf("#reportInjectionFailure(detail: string");
    expect(start).toBeGreaterThan(-1);
    const body = firefoxRuntime.slice(start, start + 600);
    expect(body).toContain("throw new Error(message)");
    expect(body).toContain("Grant GN Tracing access to this site");
  });

  it("does not treat a resolved MAIN-world injection as proof it ran in the page", () => {
    // The realm check is the only thing that separates "ran" from "ran in the
    // page realm"; without it a sandboxed or CSP-blocked injection reports success.
    expect(firefoxRuntime).toContain("#verifyPageRealm(tabId)");
    expect(firefoxRuntime).toContain('type: "VERIFY_REALM"');
    // The check must gate the success path, not run after it.
    const verifyAt = firefoxRuntime.indexOf("const realm = await this.#verifyPageRealm(tabId)");
    const returnTrueAt = firefoxRuntime.indexOf("return true;", verifyAt);
    expect(verifyAt).toBeGreaterThan(-1);
    expect(returnTrueAt).toBeGreaterThan(verifyAt);
  });
});
