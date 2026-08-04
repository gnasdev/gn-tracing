/**
 * Structural proof: full-record orchestration is behind RecordingRuntime;
 * service worker start/stop bodies do not mode-switch or cast backends.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const swSource = readFileSync(join(root, "src/background/service-worker.ts"), "utf8");
const messagesSource = readFileSync(join(root, "src/types/messages.ts"), "utf8");
const settingsSource = readFileSync(join(root, "src/background/settings-store.ts"), "utf8");
const routerSource = readFileSync(join(root, "src/background/message-router.ts"), "utf8");
const esbuildSource = readFileSync(join(root, "esbuild.config.mjs"), "utf8");
const popupHtml = readFileSync(join(root, "popup/popup.html"), "utf8");
const createRuntimeSource = readFileSync(
  join(root, "src/platform/recording-runtime/create-recording-runtime.ts"),
  "utf8",
);
const irHubSource = readFileSync(join(root, "src/background/instant-replay-cdp.ts"), "utf8");

describe("Recording runtime ownership", () => {
  it("service worker uses createRecordingRuntime and does not mode-branch start/stop", () => {
    expect(swSource).toMatch(/createRecordingRuntime/);
    expect(swSource).toMatch(/recordingRuntime\.start\(/);
    expect(swSource).toMatch(/recordingRuntime\.finalizeEvidence\(/);
    expect(swSource).toMatch(/recordingRuntime\.discard\(/);
    expect(swSource).not.toMatch(/as InPageCaptureBackend/);
    expect(swSource).not.toMatch(/getCaptureMode\(/);
    expect(swSource).not.toMatch(/captureBackend\.mode\s*===/);
    expect(swSource).not.toMatch(/const cdp = new CdpManager/);
    expect(swSource).not.toMatch(/createCaptureBackend/);
    expect(swSource).not.toMatch(/irCdpHub\?\./);
  });

  it("IN_PAGE_CAPTURE_ENTRY is a first-class MessageAction handled by primary router", () => {
    expect(messagesSource).toMatch(/\| "IN_PAGE_CAPTURE_ENTRY"/);
    expect(routerSource).toMatch(/case "IN_PAGE_CAPTURE_ENTRY"/);
    expect(routerSource).not.toMatch(/IN_PAGE_CAPTURE_ENTRY_ACTION/);
    expect(swSource).toMatch(/handleInPageCaptureEntry/);
  });

  it("IR hub factory provides a null object for non-CDP browsers", () => {
    expect(irHubSource).toMatch(/NullInstantReplayCdpHub/);
    expect(irHubSource).toMatch(/createInstantReplayCdpHubForBrowser/);
    expect(swSource).toMatch(/createInstantReplayCdpHubForBrowser/);
  });

  it("settings store no longer persists user captureMode", () => {
    expect(settingsSource).toMatch(/Legacy `captureMode`/);
    expect(settingsSource).not.toMatch(/captureMode:\s*normalizeEnum/);
  });

  it("popup has no capture-mode UI; multi-browser build remains", () => {
    expect(popupHtml).not.toMatch(/capture-mode-input|data-settings-section="captureMode"/);
    expect(esbuildSource).toMatch(/--browser/);
    expect(esbuildSource).toMatch(/in-page-capture-main/);
    expect(createRuntimeSource).toMatch(/FirefoxRecordingRuntime/);
    expect(createRuntimeSource).toMatch(/ChromiumRecordingRuntime/);
  });
});
