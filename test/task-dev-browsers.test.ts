/**
 * Contract: local full-stack `task dev` covers every shipped browser target.
 *
 * Chrome, Edge, Opera, and Firefox each need a watch + dev path; regression here
 * means a target silently drops out of day-to-day development.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");
const TASKFILE = readFileSync(resolve(ROOT, "Taskfile.yml"), "utf8");
const ESBUILD = readFileSync(resolve(ROOT, "esbuild.config.mjs"), "utf8");
const DEVELOPER = readFileSync(resolve(ROOT, "DEVELOPER.md"), "utf8");

/** Official extension browser targets (must match esbuild + Taskfile). */
const BROWSERS = ["chrome", "edge", "opera", "firefox"] as const;

describe("task dev multi-browser support", () => {
  it("esbuild accepts the same four browser targets", () => {
    expect(ESBUILD).toMatch(/normalizeBrowserTarget/);
    for (const browser of BROWSERS) {
      expect(ESBUILD).toContain(`"${browser}"`);
    }
    expect(ESBUILD).toMatch(/Use chrome, edge, opera, or firefox/);
  });

  it("task watch accepts each browser via BROWSER precondition", () => {
    const watchAt = TASKFILE.indexOf("\n  watch:");
    expect(watchAt).toBeGreaterThan(-1);
    const watchBlock = TASKFILE.slice(watchAt, watchAt + 900);
    expect(watchBlock).toMatch(/chrome\|edge\|opera\|firefox/);
    expect(watchBlock).toContain("esbuild.config.mjs --watch --browser");
    // Env BROWSER works as well as CLI var.
    expect(watchBlock).toContain('env "BROWSER"');
  });

  it("task dev accepts each browser and all", () => {
    const devAt = TASKFILE.indexOf("\n  dev:");
    expect(devAt).toBeGreaterThan(-1);
    // Slice until dev:chrome (or next top-level task after dev block start).
    const devBlock = TASKFILE.slice(devAt, TASKFILE.indexOf("\n  dev:chrome:"));
    expect(devBlock).toMatch(/chrome\|edge\|opera\|firefox\|all/);
    expect(devBlock).toContain('env "BROWSER"');
    expect(devBlock).toContain("BROWSER=all");
    for (const browser of BROWSERS) {
      expect(devBlock).toContain(`task watch BROWSER=${browser}`);
    }
    expect(devBlock).toContain("task player:dev");
    expect(devBlock).toContain("task worker:dev");
  });

  it("exposes per-browser and all aliases", () => {
    for (const browser of BROWSERS) {
      expect(TASKFILE).toContain(`\n  dev:${browser}:`);
      expect(TASKFILE).toContain(`\n  watch:${browser}:`);
      expect(TASKFILE).toContain(`\n  build:${browser === "chrome" ? "" : browser}`);
    }
    // Chrome build task is named `build` (default), not build:chrome.
    expect(TASKFILE).toMatch(/\n {2}build:\n/);
    expect(TASKFILE).toContain("\n  build:edge:");
    expect(TASKFILE).toContain("\n  build:opera:");
    expect(TASKFILE).toContain("\n  build:firefox:");
    expect(TASKFILE).toContain("\n  build:all:");
    expect(TASKFILE).toContain("\n  dev:all:");
    // dev:all is a thin alias onto BROWSER=all.
    const allAt = TASKFILE.indexOf("\n  dev:all:");
    const allBlock = TASKFILE.slice(allAt, allAt + 500);
    expect(allBlock).toContain("BROWSER: all");
  });

  it("build:all and dist:all include every browser package", () => {
    const buildAllAt = TASKFILE.indexOf("\n  build:all:");
    const buildAll = TASKFILE.slice(buildAllAt, buildAllAt + 350);
    expect(buildAll).toContain("task: build");
    expect(buildAll).toContain("task: build:edge");
    expect(buildAll).toContain("task: build:opera");
    expect(buildAll).toContain("task: build:firefox");

    const distAllAt = TASKFILE.indexOf("\n  dist:all:");
    const distAll = TASKFILE.slice(distAllAt, distAllAt + 350);
    expect(distAll).toContain("task: dist");
    expect(distAll).toContain("task: dist:edge");
    expect(distAll).toContain("task: dist:opera");
    expect(distAll).toContain("task: dist:firefox");
  });

  it("DEVELOPER.md documents the four-browser dev matrix", () => {
    expect(DEVELOPER).toMatch(/task dev/);
    expect(DEVELOPER).toMatch(/BROWSER=edge/);
    expect(DEVELOPER).toMatch(/BROWSER=opera/);
    expect(DEVELOPER).toMatch(/BROWSER=firefox/);
    expect(DEVELOPER).toMatch(/task dev:all/);
    expect(DEVELOPER).toMatch(/all four/i);
  });
});
