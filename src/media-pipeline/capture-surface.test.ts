/**
 * Measured inputs, from real engines:
 * - Firefox 153 whole screen: label="Primary Monitor", displaySurface absent.
 * - Chromium tab capture: displaySurface="browser".
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { describeCaptureSurfaceLimitation, describeSurfaceTitleMismatch } from "./capture-surface";

describe("describeCaptureSurfaceLimitation", () => {
  it("says nothing for a Chromium tab capture", () => {
    expect(describeCaptureSurfaceLimitation({ displaySurface: "browser" })).toBeNull();
  });

  it("warns about a whole screen on Chromium", () => {
    const limitation = describeCaptureSurfaceLimitation({ displaySurface: "monitor" });
    expect(limitation).toMatch(/entire screen/i);
    expect(limitation).toMatch(/not just the recorded tab/i);
  });

  it("warns about a whole screen on Firefox using the label alone", () => {
    // The exact value measured on Firefox 153; displaySurface is absent.
    const limitation = describeCaptureSurfaceLimitation({ label: "Primary Monitor" });
    expect(limitation).toMatch(/entire screen/i);
    expect(limitation).toContain("Primary Monitor");
  });

  it("recognises other screen wordings", () => {
    for (const label of ["Screen 1", "Built-in Display", "External monitor"]) {
      expect(describeCaptureSurfaceLimitation({ label })).toMatch(/entire screen/i);
    }
  });

  it("warns that a window pick still includes browser chrome", () => {
    const limitation = describeCaptureSurfaceLimitation({ label: "GN Tracing — Mozilla Firefox" });
    expect(limitation).toMatch(/captured a window/i);
    expect(limitation).toMatch(/browser interface/i);
    expect(limitation).toContain("GN Tracing");
  });

  it("prefers displaySurface over the label when both are present", () => {
    // A window whose title happens to contain "Monitor" must not read as a screen.
    const limitation = describeCaptureSurfaceLimitation({
      displaySurface: "window",
      label: "Monitor dashboard — Firefox",
    });
    expect(limitation).toMatch(/captured a window/i);
    expect(limitation).not.toMatch(/entire screen/i);
  });

  it("invents nothing when there is no signal", () => {
    expect(describeCaptureSurfaceLimitation({})).toBeNull();
    expect(describeCaptureSurfaceLimitation({ label: "" })).toBeNull();
  });

  it("handles an unnamed window without printing empty quotes", () => {
    const limitation = describeCaptureSurfaceLimitation({ displaySurface: "window" });
    expect(limitation).toContain("an unnamed surface");
    expect(limitation).not.toContain('""');
  });
});

describe("describeSurfaceTitleMismatch", () => {
  it("is silent when the window label contains the tab title", () => {
    expect(
      describeSurfaceTitleMismatch({ label: "Checkout page — Mozilla Firefox" }, "Checkout page"),
    ).toBeNull();
  });

  it("warns when the shared window clearly does not match the recorded tab", () => {
    const note = describeSurfaceTitleMismatch(
      { label: "Unrelated Spreadsheet — LibreOffice" },
      "Checkout page",
    );
    expect(note).toMatch(/does not match/i);
    expect(note).toContain("Checkout page");
    expect(note).toContain("LibreOffice");
  });

  it("does not double-warn for a whole-screen pick", () => {
    expect(describeSurfaceTitleMismatch({ label: "Primary Monitor" }, "Checkout page")).toBeNull();
  });

  it("says nothing without a title or label", () => {
    expect(describeSurfaceTitleMismatch({ label: "Win" }, "")).toBeNull();
    expect(describeSurfaceTitleMismatch({}, "Checkout")).toBeNull();
  });
});

describe("captured surface wiring", () => {
  const read = (path: string) => readFileSync(resolve(__dirname, path), "utf8");

  it("reads the surface from the live track, not from the requested constraints", () => {
    // Firefox ignores displaySurface and preferCurrentTab, so what we asked for
    // says nothing about what the user picked.
    const offscreen = read("../offscreen/offscreen.ts");
    expect(offscreen).toContain("function readCapturedSurface(");
    expect(offscreen).toContain("readCapturedSurface(activeStream)");
    expect(offscreen).toMatch(/surface\?: CapturedSurface/);
  });

  it("carries it through DISPLAY_CAPTURE_RESULT into the media host", () => {
    const host = read("../platform/media/page-host.ts");
    expect(host).toContain("surface?: CapturedSurface");
    expect(host).toContain("this.#capturedSurface = result.surface ?? {}");
    expect(host).toContain("get capturedSurface()");
  });

  it("turns it into a privacy limitation when the recording finalizes", () => {
    const runtime = read("../platform/recording-runtime/firefox-runtime.ts");
    expect(runtime).toContain("describeCaptureSurfaceLimitation(this.#media.capturedSurface)");
    // Only added when there is something to say — no empty entry in the package.
    expect(runtime).toContain("if (surfaceLimitation) {");
    expect(runtime).toContain("limitations.push(surfaceLimitation)");
  });

  it("arms evidence before restoring recorded-tab focus after share commit", () => {
    const runtime = read("../platform/recording-runtime/firefox-runtime.ts");
    const startMethod = runtime.indexOf("async start(input: RecordingStartInput)");
    const nextMethod = runtime.indexOf("\n  async ", startMethod + 10);
    const startBody = runtime.slice(startMethod, nextMethod);
    const beginAt = startBody.indexOf("this.#evidence.beginSession(");
    const restoreAt = startBody.indexOf("restoreRecordedTabFocus(");
    expect(beginAt).toBeGreaterThan(-1);
    expect(restoreAt).toBeGreaterThan(beginAt);
  });
});
