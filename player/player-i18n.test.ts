/**
 * Player i18n catalog parity and dynamic-label checks.
 *
 * Reads the shipped `player/player.js` source (and HTML shells) so the test
 * exercises the real translation tables that the extension/standalone players
 * load — not a re-implemented catalog.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..");
const playerJsPath = resolve(repoRoot, "player/player.js");
const playerHtmlPaths = [
  resolve(repoRoot, "player/player.html"),
  resolve(repoRoot, "player-standalone/index.html"),
];

function extractTranslations(source: string): {
  en: Record<string, string>;
  vi: Record<string, string>;
} {
  const start = source.indexOf("const TRANSLATIONS = ");
  if (start < 0) {
    throw new Error("const TRANSLATIONS not found in player.js");
  }
  const braceStart = source.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) {
    throw new Error("Failed to parse TRANSLATIONS object bounds");
  }
  const objectSource = source.slice(braceStart, end);
  // Evaluate the object literal from the shipped player script.
  // eslint-disable-next-line no-new-func -- intentional: parse shipped player catalog
  return new Function(`return (${objectSource})`)() as {
    en: Record<string, string>;
    vi: Record<string, string>;
  };
}

function collectHtmlI18nKeys(html: string): Set<string> {
  const keys = new Set<string>();
  const re = /data-i18n(?:-html|-aria|-title|-placeholder|-alt)?="([^"]+)"/g;
  for (const match of html.matchAll(re)) {
    keys.add(match[1]);
  }
  return keys;
}

function translate(
  catalog: { en: Record<string, string>; vi: Record<string, string> },
  language: "en" | "vi",
  key: string,
  replacements: Record<string, string> = {},
): string {
  const table = catalog[language] || catalog.en;
  const template = table[key] || catalog.en[key] || key;
  return Object.entries(replacements).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, value),
    template,
  );
}

describe("player i18n catalog", () => {
  const source = readFileSync(playerJsPath, "utf8");
  const catalog = extractTranslations(source);

  it("has identical EN and VI key sets (no orphan keys either side)", () => {
    const enKeys = Object.keys(catalog.en).sort();
    const viKeys = Object.keys(catalog.vi).sort();
    expect(enKeys).toEqual(viKeys);
    expect(enKeys.length).toBeGreaterThan(50);
  });

  it("resolves every static data-i18n* key used by player HTML shells", () => {
    const htmlKeys = new Set<string>();
    for (const htmlPath of playerHtmlPaths) {
      const html = readFileSync(htmlPath, "utf8");
      for (const key of collectHtmlI18nKeys(html)) {
        htmlKeys.add(key);
      }
    }
    expect(htmlKeys.size).toBeGreaterThan(20);
    const missing: string[] = [];
    for (const key of htmlKeys) {
      if (!catalog.en[key] || !catalog.vi[key]) {
        missing.push(key);
      }
    }
    expect(missing).toEqual([]);
  });

  it("produces non-empty, language-distinct strings for representative dynamic keys", () => {
    const sampleKeys = [
      "report.privacyTitle",
      "report.recordedSession",
      "report.chip.duration",
      "activity.click",
      "activity.scrollUp",
      "loading.unlocked",
      "detail.copyCurl",
      "detail.copyResponse",
      "detail.copied",
      "detail.time",
      "detail.toggleDetails",
      "password.enterRequired",
      "password.unlockFailed",
      "error.loadFailed",
      "sourceMap.loadedNoMatch",
      "storage.status.added",
      "elements.masked",
      "network.ws.frames",
      "network.ws.open",
      "network.ws.closed",
      "controls.exitExpandedVideo",
    ];

    for (const key of sampleKeys) {
      const en = translate(catalog, "en", key, {
        value: "1:00",
        detail: "btn",
        count: "2",
        status: "404",
        reason: "x",
        version: "1",
        profile: "standard",
        list: "video",
        item: "limit",
        index: "1",
      });
      const vi = translate(catalog, "vi", key, {
        value: "1:00",
        detail: "btn",
        count: "2",
        status: "404",
        reason: "x",
        version: "1",
        profile: "standard",
        list: "video",
        item: "limit",
        index: "1",
      });
      expect(en, key).toBeTruthy();
      expect(vi, key).toBeTruthy();
      expect(en, key).not.toEqual(vi);
      // Must not fall back to the raw key when a translation is missing.
      expect(en, key).not.toEqual(key);
      expect(vi, key).not.toEqual(key);
    }
  });

  it("wires language-toggle refresh for dynamic panels in the shipped player", () => {
    expect(source).toContain("function refreshDynamicLanguageUi");
    expect(source).toContain("refreshDynamicLanguageUi()");
    expect(source).toMatch(/renderReportPanel\s*\(/);
    expect(source).toMatch(/renderActivityPanel\s*\(/);
    expect(source).toMatch(/renderConsoleEntries\s*\(/);
    expect(source).toMatch(/renderNetworkEntries\s*\(/);
    expect(source).toMatch(/t\("loading\.unlocked"\)/);
    expect(source).toMatch(/t\("detail\.copyResponse"\)/);
    expect(source).toMatch(/t\("detail\.copied"\)/);
    expect(source).toMatch(/t\("password\.unlockFailed"\)/);
    expect(source).toMatch(/t\("network\.ws\.frames"/);
    expect(source).toMatch(/t\("controls\.exitExpandedVideo"\)/);
  });

  it("rejects bare English UI literals outside the translation catalogs", () => {
    // Strip the TRANSLATIONS object so catalog values themselves do not trip the gate.
    const start = source.indexOf("const TRANSLATIONS = ");
    const braceStart = source.indexOf("{", start);
    let depth = 0;
    let end = -1;
    for (let i = braceStart; i < source.length; i += 1) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    const codeOutsideCatalog = source.slice(0, start) + source.slice(end);

    const forbidden = [
      "Copy Response",
      "Copied!",
      "Loading unlocked recording...",
      "Failed to unlock recording package.",
      "Exit expanded video",
      // Exact fullscreen expand string used previously as a bare title assignment.
      '"Expand video in tab"',
      // WebSocket row chrome previously hard-coded these English words.
      "} frames",
      '? "Closed" : "Open"',
      '? "Closed"',
      ': "Open"',
    ];

    const hits: string[] = [];
    for (const literal of forbidden) {
      if (codeOutsideCatalog.includes(literal)) {
        hits.push(literal);
      }
    }
    expect(hits).toEqual([]);
  });
});
