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
