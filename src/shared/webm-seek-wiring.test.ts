/**
 * Structural checks that upload and player entrypoints share one cues-based
 * seek contract (not a second duration-only algorithm).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeWebmSeekable } from "./webm-seek-fix";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function readRepo(...parts: string[]): string {
  return fs.readFileSync(path.join(repoRoot, ...parts), "utf8");
}

function existsRepo(...parts: string[]): boolean {
  return fs.existsSync(path.join(repoRoot, ...parts));
}

describe("webm seek single-path wiring", () => {
  it("shared module is a thin cues wrapper only", () => {
    const source = readRepo("src/shared/webm-seek-fix.ts");
    expect(source).toContain('import fixWebmDurationWithCues from "webm-duration-fix"');
    expect(source).toContain("export async function makeWebmSeekable");
    // Phase-1 duration mini-parser must stay deleted.
    expect(source).not.toMatch(/class WebmFile|fixDuration\(|tryDurationOnlyFallback/);
    expect(source).not.toMatch(/hasSeekMetadataMarkers|0x4489/);
  });

  it("offscreen packages seek-fixed blob before splitBlobIntoParts", () => {
    const source = readRepo("src/offscreen/offscreen.ts");
    expect(source).toContain('import { makeWebmSeekable } from "../shared/webm-seek-fix"');

    const makeIdx = source.indexOf("makeWebmSeekable(snapshot.blob");
    const splitIdx = source.indexOf("splitBlobIntoParts(packagedVideoBlob");
    expect(makeIdx).toBeGreaterThan(-1);
    expect(splitIdx).toBeGreaterThan(-1);
    expect(makeIdx).toBeLessThan(splitIdx);
    expect(source).toContain("totalBytes: packagedVideoBlob.size");
    // No durationMs options on the new contract.
    expect(source).not.toMatch(/makeWebmSeekable\([^)]*durationMs/);
  });

  it("player uses gnMakeWebmSeekable before createObjectURL (same contract)", () => {
    const source = readRepo("player/player.js");
    expect(source).toContain("gnMakeWebmSeekable");
    expect(source).toContain("async function prepareSeekableVideoBlob");
    // Old dual stack must be gone.
    expect(source).not.toContain("ysFixWebmDuration");
    expect(source).not.toContain("GnWebmDurationFix");

    const prepareIdx = source.indexOf("prepareSeekableVideoBlob(blob, videoMimeType)");
    const objectUrlIdx = source.indexOf("URL.createObjectURL(playableBlob)");
    expect(prepareIdx).toBeGreaterThan(-1);
    expect(objectUrlIdx).toBeGreaterThan(-1);
    expect(prepareIdx).toBeLessThan(objectUrlIdx);
  });

  it("HTML loads a single seek-fix vendor before player runtime", () => {
    const extensionHtml = readRepo("player/player.html");
    const standaloneHtml = readRepo("player-standalone/index.html");
    const vendorScript =
      /<script\b[^>]*\bsrc=["'][^"']*vendor\/webm-seek-fix\/webm-seek-fix\.iife\.js["']/;
    const obsoleteDuration =
      /vendor\/webm-seek-fix\/(fix-webm-duration|webm-duration-fix\.iife)\.js/;

    for (const html of [extensionHtml, standaloneHtml]) {
      expect(html).toMatch(vendorScript);
      expect(html).not.toMatch(obsoleteDuration);
    }

    const extVendor = extensionHtml.search(vendorScript);
    const extPlayer = extensionHtml.search(/<script\b[^>]*\bsrc=["']player\.js["']/);
    expect(extVendor).toBeGreaterThan(-1);
    expect(extPlayer).toBeGreaterThan(extVendor);

    const saVendor = standaloneHtml.search(vendorScript);
    const saMain = standaloneHtml.search(/<script\b[^>]*\bsrc=["'][^"']*src\/main\.ts["']/);
    expect(saVendor).toBeGreaterThan(-1);
    expect(saMain).toBeGreaterThan(saVendor);
  });

  it("vendor artifact exposes gnMakeWebmSeekable and no second duration stack", () => {
    expect(existsRepo("player", "vendor", "webm-seek-fix", "webm-seek-fix.iife.js")).toBe(true);
    expect(existsRepo("player", "vendor", "webm-seek-fix", "LICENSE")).toBe(true);
    expect(existsRepo("player", "vendor", "webm-seek-fix", "fix-webm-duration.js")).toBe(false);
    expect(existsRepo("player", "vendor", "webm-seek-fix", "webm-duration-fix.iife.js")).toBe(
      false,
    );

    const vendor = readRepo("player/vendor/webm-seek-fix/webm-seek-fix.iife.js");
    expect(vendor).toContain("gnMakeWebmSeekable");
    expect(vendor).toMatch(/webm-duration-fix|makeMetadataSeekable|Decoder/);

    expect(
      existsRepo("player-standalone", "public", "vendor", "webm-seek-fix", "webm-seek-fix.iife.js"),
    ).toBe(true);
    const publicPlayer = readRepo("player-standalone", "public", "player.js");
    expect(publicPlayer).toContain("gnMakeWebmSeekable");
    expect(publicPlayer).not.toContain("ysFixWebmDuration");
  });

  it("shared makeWebmSeekable remains the export offscreen imports", async () => {
    const empty = new Blob([], { type: "video/webm" });
    const result = await makeWebmSeekable(empty);
    expect(result.ok).toBe(false);
    expect(result.blob).toBe(empty);
  });
});
