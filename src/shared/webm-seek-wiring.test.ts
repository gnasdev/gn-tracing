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
    expect(source).toContain('import fixWebmDurationWithCuesImport from "webm-duration-fix"');
    expect(source).toContain("export async function makeWebmSeekable");
    expect(source).toContain("resolveFixWebmDurationWithCues");
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
    const source = readRepo("player/public/player.js");
    expect(source).toContain("gnMakeWebmSeekable");
    expect(source).toContain("async function prepareSeekableVideoBlob");
    expect(source).toContain("ensurePlayableVideoBlobType");
    expect(source).toContain("function seekVideoToMs");
    expect(source).toContain("pendingSeekTimeMs");
    // Runtime uses vendored pure helpers — no hand-ported reconcileSeekClock body.
    expect(source).toContain("globalThis.gnCore");
    expect(source).toContain("function applySeekClock");
    expect(source).toContain("TimelineSeek.reconcileSeekClock");
    expect(source).not.toContain("function reconcileSeekClock");
    expect(source).toContain("timelineDurationLocked");
    expect(source).toContain("waitForVideoMetadata");
    expect(source).toContain("lockTimelineDurationFromMedia");
    // Must not blindly commit video.currentTime on every seeked (snap-back).
    expect(source).not.toMatch(
      /addEventListener\(\s*["']seeked["'][\s\S]{0,200}currentTimeMs\s*=\s*elements\.video\.currentTime/,
    );
    // Shared pure contract + vendor IIFE.
    const pure = readRepo("src/shared/player-timeline-seek.ts");
    expect(pure).toContain("export function reconcileSeekClock");
    expect(pure).toContain("export function resolveTimelineDurationMs");
    expect(existsRepo("player", "public", "vendor", "gn-core", "gn-core.iife.js")).toBe(true);
    // Old dual stack must be gone.
    expect(source).not.toContain("ysFixWebmDuration");
    expect(source).not.toContain("GnWebmDurationFix");

    const prepareIdx = source.indexOf("prepareSeekableVideoBlob(blob, videoMimeType)");
    const objectUrlIdx = source.indexOf("URL.createObjectURL(playableBlob)");
    expect(prepareIdx).toBeGreaterThan(-1);
    expect(objectUrlIdx).toBeGreaterThan(-1);
    expect(prepareIdx).toBeLessThan(objectUrlIdx);
  });

  it("static player.html loads seek vendors before player runtime", () => {
    // Hosted Solid app (index.html) imports TS modules via Vite; vendor IIFEs
    // remain for the static e2e shell under public/player.html.
    const staticHtml = readRepo("player/public/player.html");
    const vendorScript =
      /<script\b[^>]*\bsrc=["'][^"']*vendor\/webm-seek-fix\/webm-seek-fix\.iife\.js["']/;
    const timelineVendor = /<script\b[^>]*\bsrc=["'][^"']*vendor\/gn-core\/gn-core\.iife\.js["']/;
    const obsoleteDuration =
      /vendor\/webm-seek-fix\/(fix-webm-duration|webm-duration-fix\.iife)\.js/;

    expect(staticHtml).toMatch(vendorScript);
    expect(staticHtml).toMatch(timelineVendor);
    expect(staticHtml).not.toMatch(obsoleteDuration);

    const stVendor = staticHtml.search(vendorScript);
    const stTimeline = staticHtml.search(timelineVendor);
    const stPlayer = staticHtml.search(/<script\b[^>]*\bsrc=["']player\.js["']/);
    expect(stVendor).toBeGreaterThan(-1);
    expect(stTimeline).toBeGreaterThan(stVendor);
    expect(stPlayer).toBeGreaterThan(stTimeline);

    const solidShell = readRepo("player/index.html");
    expect(solidShell).toMatch(/src\/main\.ts/);
  });

  it("vendor artifact exposes gnMakeWebmSeekable and no second duration stack", () => {
    expect(existsRepo("player", "public", "vendor", "webm-seek-fix", "webm-seek-fix.iife.js")).toBe(
      true,
    );
    expect(existsRepo("player", "public", "vendor", "webm-seek-fix", "LICENSE")).toBe(true);
    expect(existsRepo("player", "public", "vendor", "webm-seek-fix", "fix-webm-duration.js")).toBe(
      false,
    );
    expect(
      existsRepo("player", "public", "vendor", "webm-seek-fix", "webm-duration-fix.iife.js"),
    ).toBe(false);

    const vendor = readRepo("player/public/vendor/webm-seek-fix/webm-seek-fix.iife.js");
    expect(vendor).toContain("gnMakeWebmSeekable");
    expect(vendor).toMatch(/webm-duration-fix|makeMetadataSeekable|Decoder/);

    const publicPlayer = readRepo("player/public/player.js");
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
