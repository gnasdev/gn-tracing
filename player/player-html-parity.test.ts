/**
 * Keep extension and standalone player shells aligned on critical DOM ids.
 *
 * `sync-player.js` only copies player.js/css/vendor — markup lives in two HTML
 * files. When they drift (missing screenshots tab, no-video notice, …) the JS
 * binds to null and features disappear silently.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..");

const REQUIRED_IDS = [
  "video-section",
  "no-video-notice",
  "no-video-notice-title",
  "no-video-notice-hint",
  "dom-stage",
  "dom-stage-frame",
  "dom-stage-scrubber",
  "dom-stage-prev",
  "dom-stage-next",
  "dom-stage-time",
  "dom-stage-url",
  "video-container",
  "video-player",
  "still-stage",
  "still-viewport",
  "still-transform",
  "still-figure",
  "still-image",
  "still-overlay",
  "still-zoom-in-btn",
  "still-zoom-out-btn",
  "still-zoom-label",
  "still-rotate-btn",
  "still-prev-btn",
  "still-next-btn",
  "still-shot-label",
  "still-caption-row",
  "still-caption",
  "still-url",
  "still-layout-horizontal-btn",
  "still-layout-vertical-btn",
  "still-fullscreen-btn",
  "still-fullscreen-enter-icon",
  "still-fullscreen-exit-icon",
  "layout-splitter",
  "logs-panel",
  "report-tab",
  "activity-tab",
  "console-tab",
  "network-tab",
  "storage-tab",
  "elements-tab",
  "elements-search",
  "screenshots-tab",
  "report-viewer",
  "activity-viewer",
  "console-viewer",
  "network-viewer",
  "storage-viewer",
  "elements-viewer",
  "screenshots-viewer",
  "screenshots-content",
  "copy-for-ai-btn",
];

const REQUIRED_LOADING_IDS = [
  "loading-state",
  "loading-message",
  "loading-progress-bar",
  "loading-progress-fill",
  "loading-progress-text",
  "password-state",
  "error-state",
  "intro-state",
  "player-state",
];

function collectIds(html: string): Set<string> {
  const ids = new Set<string>();
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) {
    ids.add(match[1]);
  }
  return ids;
}

function hasClassOnId(html: string, id: string, className: string): boolean {
  const re = new RegExp(`id="${id}"[^>]*class="([^"]*)"`, "i");
  const m = html.match(re);
  if (!m) {
    return false;
  }
  return m[1].split(/\s+/).includes(className);
}

describe("player HTML shell parity", () => {
  const extensionHtml = readFileSync(resolve(repoRoot, "player/player.html"), "utf8");
  const standaloneHtml = readFileSync(resolve(repoRoot, "player-standalone/index.html"), "utf8");
  const extensionIds = collectIds(extensionHtml);
  const standaloneIds = collectIds(standaloneHtml);

  for (const id of REQUIRED_IDS) {
    it(`extension player.html has #${id}`, () => {
      expect(extensionIds.has(id), `missing #${id} in player/player.html`).toBe(true);
    });

    it(`standalone index.html has #${id}`, () => {
      expect(standaloneIds.has(id), `missing #${id} in player-standalone/index.html`).toBe(true);
    });
  }

  for (const id of REQUIRED_LOADING_IDS) {
    it(`extension player.html has loading shell #${id}`, () => {
      expect(extensionIds.has(id), `missing #${id} in player/player.html`).toBe(true);
    });

    it(`standalone index.html has loading shell #${id}`, () => {
      expect(standaloneIds.has(id), `missing #${id} in player-standalone/index.html`).toBe(true);
    });
  }

  it("both shells show loading-state by default", () => {
    expect(hasClassOnId(extensionHtml, "loading-state", "hidden")).toBe(false);
    expect(hasClassOnId(standaloneHtml, "loading-state", "hidden")).toBe(false);
  });

  it("both shells hide intro-state by default", () => {
    expect(hasClassOnId(extensionHtml, "intro-state", "hidden")).toBe(true);
    expect(hasClassOnId(standaloneHtml, "intro-state", "hidden")).toBe(true);
  });

  it("loading progress bar exposes progressbar role", () => {
    expect(extensionHtml).toMatch(/id="loading-progress-bar"[\s\S]*?role="progressbar"/);
    expect(standaloneHtml).toMatch(/id="loading-progress-bar"[\s\S]*?role="progressbar"/);
  });
});
