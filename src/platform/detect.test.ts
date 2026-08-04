/**
 * Browser target + feature flag resolution.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHROMIUM_EXTENSION_CAPABILITIES,
  FIREFOX_EXTENSION_CAPABILITIES,
  getProducerCapabilities,
} from "./capabilities";
import {
  getBrowserTarget,
  getCaptureMode,
  getFeatureFlags,
  getMediaHostKind,
  isChromiumTarget,
  isFirefoxTarget,
} from "./detect";

describe("platform detect", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to chrome when define is missing", () => {
    expect(getBrowserTarget()).toBe("chrome");
    expect(isChromiumTarget()).toBe(true);
    expect(isFirefoxTarget()).toBe(false);
  });

  it("chrome flags enable CDP, tabCapture, offscreen, getAuthToken", () => {
    const flags = getFeatureFlags("chrome");
    expect(flags).toEqual({
      cdp: true,
      tabCapture: true,
      offscreen: true,
      chromeIdentityGetAuthToken: true,
      displayMediaPicker: false,
      instantReplayCdpAllowlist: true,
    });
    expect(getCaptureMode("chrome")).toBe("cdp");
    expect(getMediaHostKind("chrome")).toBe("offscreen");
  });

  it("edge matches chromium capture APIs but forces web auth", () => {
    const flags = getFeatureFlags("edge");
    expect(flags.cdp).toBe(true);
    expect(flags.tabCapture).toBe(true);
    expect(flags.offscreen).toBe(true);
    expect(flags.chromeIdentityGetAuthToken).toBe(false);
    expect(getCaptureMode("edge")).toBe("cdp");
    expect(getMediaHostKind("edge")).toBe("offscreen");
  });

  it("firefox uses in-page capture and extension-page media host", () => {
    const flags = getFeatureFlags("firefox");
    expect(flags).toEqual({
      cdp: false,
      tabCapture: false,
      offscreen: false,
      chromeIdentityGetAuthToken: false,
      displayMediaPicker: true,
      instantReplayCdpAllowlist: false,
    });
    expect(getCaptureMode("firefox")).toBe("in-page");
    expect(getMediaHostKind("firefox")).toBe("extension-page");
  });
});

describe("platform capabilities", () => {
  it("chromium capabilities include cross-origin and source-maps", () => {
    const caps = getProducerCapabilities("chrome");
    expect(caps).toEqual(CHROMIUM_EXTENSION_CAPABILITIES);
    expect(caps).toContain("cross-origin");
    expect(caps).toContain("source-maps");
    expect(caps).toContain("cookies");
    expect(caps).toContain("video");
  });

  it("edge uses the same capability set as chrome", () => {
    expect(getProducerCapabilities("edge")).toEqual(getProducerCapabilities("chrome"));
  });

  it("firefox omits CDP-only capabilities but keeps video and screenshot", () => {
    const caps = getProducerCapabilities("firefox");
    expect(caps).toEqual(FIREFOX_EXTENSION_CAPABILITIES);
    expect(caps).toContain("video");
    expect(caps).toContain("screenshot");
    expect(caps).toContain("network-bodies");
    expect(caps).not.toContain("cross-origin");
    expect(caps).not.toContain("source-maps");
    expect(caps).not.toContain("cookies");
  });
});
