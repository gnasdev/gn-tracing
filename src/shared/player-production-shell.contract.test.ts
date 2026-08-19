/**
 * Structural contract for the production player shell (`player/public/player.js`).
 * Guards modularization invariants without a headless browser.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseZipCentralDirectory } from "../../packages/replay-core/src/zip-reader";
import { findActiveEventIndexByRelativeMs } from "./player-clock-index";
import { formatMessage, TRANSLATIONS } from "./player-i18n";
import { aggregateLoadingProgress } from "./player-loading-progress";
import { resolvePresentationMode } from "./player-presentation";
import { diffStorageGroups } from "./storage-diff";

const playerJs = readFileSync(resolve(__dirname, "../../player/public/player.js"), "utf8");
const playerCss = readFileSync(resolve(__dirname, "../../player/public/player.css"), "utf8");
const playerHtml = readFileSync(resolve(__dirname, "../../player/index.html"), "utf8");
const staticPlayerHtml = readFileSync(
  resolve(__dirname, "../../player/public/player.html"),
  "utf8",
);
const coreIife = readFileSync(
  resolve(__dirname, "../../player/public/vendor/gn-core/gn-core.iife.js"),
  "utf8",
);
const zipParser = readFileSync(resolve(__dirname, "../../player/src/zip-parser.ts"), "utf8");

describe("production player shell contract", () => {
  it("requires gnCore at boot and never invents presentation chrome in the shell", () => {
    expect(playerJs).toContain("function assertGnCore");
    expect(playerJs).toContain('["presentation", "resolvePresentationMode"]');
    expect(playerJs).toContain("globalThis.gnCore.presentation.resolvePresentationMode(evidence)");
    // No inline policy objects or interim helpers that hardcode mode/tabs.
    expect(playerJs).not.toMatch(/function applyNoVideoPresentation\b/);
    expect(playerJs).not.toMatch(/mode:\s*hasNoVideo\s*\?\s*["']sdk-logs["']/);
    expect(playerJs).not.toMatch(/Fallback when gn-core is missing/i);
    expect(playerJs).not.toMatch(/mirror shared resolvePresentationMode/i);
    // Production path applies chrome only from buildPresentationPlan (shared resolver).
    expect(playerJs).toMatch(
      /const presentationPlan = buildPresentationPlan\(\{[\s\S]*?\}\);\s*[\s\S]*?applyPresentationMode\(presentationPlan/,
    );
  });

  it("renders Report as an accessible topbar popover instead of a logs tab", () => {
    for (const html of [playerHtml, staticPlayerHtml]) {
      const logsPanelIndex = html.indexOf('id="logs-panel"');
      const reportViewerIndex = html.indexOf('id="report-viewer"');
      const reportMenuIndex = html.indexOf('id="report-menu"');
      const headerInfoIndex = html.indexOf('class="header-info"');
      const feedbackButtonIndex = html.indexOf('id="player-feedback-btn-header"');

      expect(html).toContain('id="report-menu"');
      expect(html).toContain('id="report-button"');
      expect(html).toContain('id="report-popover"');
      expect(html).not.toContain('id="report-tab"');
      expect(reportViewerIndex).toBeGreaterThan(-1);
      expect(reportViewerIndex).toBeLessThan(logsPanelIndex);
      expect(headerInfoIndex).toBeLessThan(reportMenuIndex);
      expect(reportMenuIndex).toBeLessThan(feedbackButtonIndex);
    }
    expect(playerJs).toContain("function setReportPopoverOpen(open)");
    expect(playerJs).toContain('event.key === "Escape"');
    expect(playerJs).not.toContain("elements.reportTab");
    expect(playerCss).toContain(".report-popover {");
    expect(playerCss).toMatch(
      /\.report-button \{[\s\S]*?width: 32px;[\s\S]*?min-width: 32px;[\s\S]*?padding: 0;/,
    );
    expect(playerCss).toContain(".report-button .ph");
  });

  it("wires storage-diff, clock-index, loading-progress, zip, and i18n through gnCore", () => {
    expect(playerJs).toContain("gnCore.storageDiff.diffStorageGroups");
    expect(playerJs).toContain("gnCore.clockIndex.findActiveEventIndexByRelativeMs");
    expect(playerJs).toContain("gnCore.loadingProgress.aggregateLoadingProgress");
    expect(playerJs).toContain("gnCore.zip.parseZipCentralDirectory");
    expect(playerJs).toContain("gnCore.i18n.formatMessage");
    expect(playerJs).toContain("let TRANSLATIONS = null");
    expect(playerJs).not.toMatch(/const TRANSLATIONS = \{/);
  });

  it("gates console/network panel work on seek and playback (no dual full-list seek path)", () => {
    // Single gated path for playhead-driven panel DOM.
    expect(playerJs).toContain("function syncPanelsToPlayhead");
    expect(playerJs).toContain("function schedulePanelSync");
    expect(playerJs).toContain("const SEEK_PANEL_SYNC_MS");
    expect(playerJs).toContain("const PLAYBACK_PANEL_SYNC_MS");
    // Scrub path must throttle; discrete seeks force-flush.
    expect(playerJs).toMatch(/scrubbing:\s*true/);
    expect(playerJs).toMatch(/throttleMs:\s*SEEK_PANEL_SYNC_MS/);
    // seekVideoToMs must not still call both list renderers directly.
    const seekFn = playerJs.match(
      /function seekVideoToMs\(timeMs, options = \{\}\) \{[\s\S]*?\n {2}function seekToRatio/,
    );
    expect(seekFn?.[0] ?? "").toContain("schedulePanelSync");
    expect(seekFn?.[0] ?? "").not.toMatch(/renderConsoleEntries\(\)/);
    expect(seekFn?.[0] ?? "").not.toMatch(/renderNetworkEntries\(\)/);
    // Hidden-tab dirty flags still used by the gated helper.
    expect(playerJs).toMatch(
      /function syncPanelsToPlayhead[\s\S]*?consolePanelDirty = true[\s\S]*?networkPanelDirty = true/,
    );
  });

  it("keeps activity highlight and video layout work O(changed) on the playhead path", () => {
    expect(playerJs).toContain("function rebuildUserEventTimesCache");
    expect(playerJs).toContain("activityEventNodes");
    expect(playerJs).toContain("activityFirstFutureIndex");
    expect(playerJs).toContain("invalidateVideoContentRectCache");
    expect(playerJs).toContain("videoContentRectCache");
    expect(playerJs).toContain("maybeCapLogDomTail");
    expect(playerJs).toContain("LOG_DOM_TAIL_MAX");
    // Activity highlight must not re-query + toggle every row each tick.
    const highlightFn = playerJs.match(
      /function updateActivityHighlight\(options = \{\}\) \{[\s\S]*?\n {2}function renderActivityPanel/,
    );
    expect(highlightFn?.[0] ?? "").toContain("activityEventNodes");
    expect(highlightFn?.[0] ?? "").not.toMatch(/querySelectorAll\(\s*["']\.event-item["']\s*\)/);
    // Content rect is cached after the first layout read.
    expect(playerJs).toMatch(/function getVideoContentRect\(\) \{\s*if \(videoContentRectCache\)/);
    // gnCore clock helpers required at boot for the cached times path.
    expect(playerJs).toContain('["clockIndex", "eventRelativeTimesMs"]');
    expect(playerJs).toContain('["clockIndex", "indexAtOrBefore"]');
  });

  it("player zip-parser re-exports the canonical replay-core reader", () => {
    expect(zipParser).toContain('from "../../packages/replay-core/src/zip-reader"');
    expect(zipParser).toContain("parseZipCentralDirectory");
    // Shipped function still works on a minimal invalid buffer.
    const result = parseZipCentralDirectory(new Uint8Array([0, 1, 2]));
    expect(result.ok).toBe(false);
  });

  it("gn-core IIFE embeds the shared domain symbols used by production", () => {
    for (const token of [
      "diffStorageGroups",
      "findActiveEventIndexByRelativeMs",
      "aggregateLoadingProgress",
      "parseZipCentralDirectory",
      "formatMessage",
      "resolvePresentationMode",
    ]) {
      expect(coreIife).toContain(token);
    }
  });

  it("renders console stack traces with network-style gray-frame filtering", () => {
    expect(playerJs).toContain("const consoleStackVendorFilters = new Map();");
    expect(playerJs).toMatch(
      /function shouldHideConsoleVendorFrames\(index\) \{\s*return consoleStackVendorFilters\.get\(index\) !== false;/,
    );
    expect(playerJs).toContain('class="console-stack-filter-toggle');
    expect(playerJs).toMatch(
      /class="console-stack \$\{hideVendorFrames \? "hide-vendor-frames" : ""\}"/,
    );
    expect(playerJs).toContain("isVendorFrame: isNetworkVendorFrame,");
    expect(playerJs).toMatch(
      /const consoleStackToggle = e\.target\.closest\(["']\.console-stack-filter-toggle["']\);/,
    );
  });

  it("uses one stack trace renderer across console, network, and remote-object details", () => {
    expect(playerJs).toContain("function renderStackTrace(frames, options = {})");
    expect(playerJs).toContain(
      "renderStackTrace(buildInitiatorStackTraceFrames(initiator.stack), {",
    );
    expect(playerJs).toContain(
      "renderStackTrace(frames, { sourceMapNote: getSourceMapDiagnosticMessage })",
    );
    expect(playerJs).toContain("renderStackTrace(entry.stackTrace, {");
    expect(playerJs).toContain("isVendorFrame: isNetworkVendorFrame,");
    expect(playerJs).not.toContain("function renderInitiatorStackFrames(stack)");
  });

  it("visually separates stack function names and source paths across player panels", () => {
    expect(playerCss).toContain(`
.console-detail .stack-frame .fn-name {
  color: var(--warning);
  font-weight: 650;
  -webkit-text-stroke: 0.25px color-mix(in srgb, currentColor 78%, var(--text-inverse));
  background: var(--bg-warning-soft);
  border-radius: 3px;
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
  padding: 0 2px;
}`);
    expect(playerCss).toContain(`
.console-detail .stack-frame .location {
  color: var(--info);
  font-family: "SF Mono", "Fira Code", monospace;
  font-weight: 500;
  -webkit-text-stroke: 0.25px color-mix(in srgb, currentColor 78%, var(--text-inverse));
  background: color-mix(in srgb, var(--info) 16%, transparent);
  border-radius: 3px;
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
  padding: 0 2px;
}`);
    expect(playerCss).toContain(`
.network-detail .stack-frame .fn-name,
.ws-detail .stack-frame .fn-name {
  color: var(--warning);
  font-weight: 650;
  -webkit-text-stroke: 0.25px color-mix(in srgb, currentColor 78%, var(--text-inverse));
  background: var(--bg-warning-soft);
  border-radius: 3px;
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
  padding: 0 2px;
}`);
    expect(playerCss).toContain(`
.network-detail .stack-frame .location,
.ws-detail .stack-frame .location {
  color: var(--info);
  font-family: "SF Mono", "Fira Code", monospace;
  font-weight: 500;
  -webkit-text-stroke: 0.25px color-mix(in srgb, currentColor 78%, var(--text-inverse));
  background: color-mix(in srgb, var(--info) 16%, transparent);
  border-radius: 3px;
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
  padding: 0 2px;
}`);
    expect(playerCss).toContain(`
.console-stack .vendor-frame,
.console-stack .vendor-frame .fn-name,
.console-stack .vendor-frame .location {
  color: var(--text-muted);
  -webkit-text-stroke: 0;
  background: transparent;
}`);
    expect(playerCss).toContain(`
.network-detail .stack-frame.vendor-frame .fn-name,
.network-detail .stack-frame.vendor-frame .location,
.ws-detail .stack-frame.vendor-frame .fn-name,
.ws-detail .stack-frame.vendor-frame .location {
  color: var(--text-muted);
  -webkit-text-stroke: 0;
  background: transparent;
}`);
  });

  it("preserves media resources when pagehide enters the BFCache", () => {
    expect(playerJs).not.toMatch(/addEventListener\(["']unload["']/);
    expect(playerJs).toContain("function releasePlayerResourcesOnPageHide(event) {");
    expect(playerJs).toContain("if (event.persisted) {");
    expect(playerJs).toContain(
      'window.addEventListener("pagehide", releasePlayerResourcesOnPageHide);',
    );
  });

  it("shared domain functions are the real implementations (smoke)", () => {
    expect(diffStorageGroups([{ key: "a", value: "1" }], []).map((r) => r.status)).toEqual([
      "removed",
    ]);
    expect(findActiveEventIndexByRelativeMs([{ relativeMs: 10 }, { relativeMs: 20 }], 15)).toBe(0);
    expect(aggregateLoadingProgress([], 0).percent).toBe(0);
    expect(formatMessage("en", "loading.message")).toContain("Loading");
    expect(Object.keys(TRANSLATIONS.en).length).toBe(Object.keys(TRANSLATIONS.vi).length);
    const plan = resolvePresentationMode({
      hasVideo: false,
      screenshotCount: 1,
      consoleCount: 0,
      networkCount: 0,
      websocketCount: 0,
      activityCount: 0,
      hasStorage: false,
      hasDom: false,
      hasReportContent: false,
      expectsLogTabs: false,
    });
    expect(plan.mode).toBe("screenshot");
    expect(plan.showConsoleTab).toBe(false);
  });
});
