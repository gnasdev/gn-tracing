/**
 * Structural proof that full Record is CDP-only (no in-page capture mode).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const swSource = readFileSync(join(root, "src/background/service-worker.ts"), "utf8");
const messagesSource = readFileSync(join(root, "src/types/messages.ts"), "utf8");
const settingsSource = readFileSync(join(root, "src/background/settings-store.ts"), "utf8");
const esbuildSource = readFileSync(join(root, "esbuild.config.mjs"), "utf8");
const popupHtml = readFileSync(join(root, "popup/popup.html"), "utf8");

describe("Record is CDP-only", () => {
  it("service worker always attaches CDP on start without in-page branch", () => {
    expect(swSource).toMatch(/cdp\.attach\(/);
    expect(swSource).not.toMatch(/captureMode\s*===\s*["']in-page["']/);
    expect(swSource).not.toMatch(/startInPageCapture|stopInPageCapture|waitForInPageDrain/);
    expect(swSource).not.toMatch(/IN_PAGE_CAPTURE_SCRIPT|IN_PAGE_RELAY_SCRIPT/);
    expect(swSource).not.toMatch(/handleRecordingInPageEntry|shouldAcceptInPageEntry/);
  });

  it("does not accept RECORDING_INPAGE_ENTRY messages", () => {
    expect(messagesSource).not.toMatch(/RECORDING_INPAGE_ENTRY/);
    expect(swSource).not.toMatch(/RECORDING_INPAGE_ENTRY/);
  });

  it("settings store no longer persists captureMode", () => {
    expect(settingsSource).toMatch(/Legacy `captureMode`/);
    expect(settingsSource).not.toMatch(/captureMode:\s*normalizeEnum/);
    expect(settingsSource).not.toMatch(/captureMode:\s*["']cdp["']/);
  });

  it("build and popup omit extension in-page content scripts and UI", () => {
    expect(esbuildSource).not.toMatch(/in-page-capture|in-page-relay/);
    expect(popupHtml).not.toMatch(/capture-mode-input|data-settings-section="captureMode"/);
    expect(popupHtml).not.toMatch(/value="in-page"/);
  });
});
