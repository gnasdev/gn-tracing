/**
 * Browser target + feature flag resolution.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHROMIUM_EXTENSION_CAPABILITIES,
  FIREFOX_EXTENSION_CAPABILITIES,
  getProducerCapabilities,
  getProducerEvidenceCoverage,
  SAFARI_EXTENSION_CAPABILITIES,
  SAFARI_IOS_EXTENSION_CAPABILITIES,
} from "./capabilities";
import {
  getBrowserTarget,
  getCaptureMode,
  getFeatureFlags,
  getMediaHostKind,
  isChromiumTarget,
  isFirefoxTarget,
  isSafariIosTarget,
  isSafariTarget,
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
      video: true,
      inPageNetworkCapture: false,
    });
    expect(getCaptureMode("chrome")).toBe("cdp");
    expect(getMediaHostKind("chrome")).toBe("offscreen");
  });

  it("edge and opera match chromium capture but force web auth", () => {
    for (const target of ["edge", "opera"] as const) {
      const flags = getFeatureFlags(target);
      expect(flags.cdp).toBe(true);
      expect(flags.tabCapture).toBe(true);
      expect(flags.offscreen).toBe(true);
      expect(flags.chromeIdentityGetAuthToken).toBe(false);
      expect(getCaptureMode(target)).toBe("cdp");
      expect(getMediaHostKind(target)).toBe("offscreen");
      expect(isChromiumTarget(target)).toBe(true);
    }
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
      video: true,
      inPageNetworkCapture: false,
    });
    expect(getCaptureMode("firefox")).toBe("in-page");
    expect(getMediaHostKind("firefox")).toBe("extension-page");
  });

  it("macOS safari matches firefox's in-page capture and media host", () => {
    const flags = getFeatureFlags("safari");
    expect(flags).toEqual(getFeatureFlags("firefox"));
    expect(getCaptureMode("safari")).toBe("in-page");
    expect(getMediaHostKind("safari")).toBe("extension-page");
    expect(isSafariTarget("safari")).toBe(true);
    expect(isSafariTarget("safari-ios")).toBe(false);
  });

  it("safari-ios has no video and captures network in-page", () => {
    const flags = getFeatureFlags("safari-ios");
    expect(flags).toEqual({
      cdp: false,
      tabCapture: false,
      offscreen: false,
      chromeIdentityGetAuthToken: false,
      displayMediaPicker: false,
      instantReplayCdpAllowlist: false,
      video: false,
      inPageNetworkCapture: true,
    });
    expect(getCaptureMode("safari-ios")).toBe("in-page");
    expect(getMediaHostKind("safari-ios")).toBe("none");
    expect(isSafariIosTarget("safari-ios")).toBe(true);
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

  it("edge and opera use the same capability set as chrome", () => {
    expect(getProducerCapabilities("edge")).toEqual(getProducerCapabilities("chrome"));
    expect(getProducerCapabilities("opera")).toEqual(getProducerCapabilities("chrome"));
  });

  it("declares only shipped adapter coverage for each browser path", () => {
    const chromium = getProducerEvidenceCoverage("chrome");
    expect(chromium.surfaces["network-response-body"]).toEqual({ source: "cdp", quality: "full" });
    expect(chromium.surfaces["source-map-resolution"]).toEqual({ source: "cdp", quality: "full" });

    const firefox = getProducerEvidenceCoverage("firefox");
    expect(firefox.surfaces["network-lifecycle"]).toEqual({
      source: "web-request",
      quality: "full",
    });
    expect(firefox.surfaces["network-response-body"]).toBeUndefined();
    expect(firefox.surfaces["runtime-object-details"]).toEqual({
      source: "in-page",
      quality: "partial",
    });

    const safariIos = getProducerEvidenceCoverage("safari-ios");
    expect(safariIos.surfaces["network-lifecycle"]).toEqual({
      source: "in-page",
      quality: "partial",
    });
  });

  it("firefox omits CDP-only capabilities but keeps video and screenshot", () => {
    const caps = getProducerCapabilities("firefox");
    expect(caps).toEqual(FIREFOX_EXTENSION_CAPABILITIES);
    expect(caps).toContain("video");
    expect(caps).toContain("screenshot");
    // Full-record network is observe-only webRequest (responseBody always null);
    // claiming "network-bodies" would tell readers bodies exist when none do.
    expect(caps).not.toContain("network-bodies");
    expect(caps).not.toContain("cross-origin");
    expect(caps).not.toContain("source-maps");
    expect(caps).not.toContain("cookies");
  });

  it("macOS safari matches firefox's capability set", () => {
    expect(getProducerCapabilities("safari")).toEqual(SAFARI_EXTENSION_CAPABILITIES);
    expect(getProducerCapabilities("safari")).toEqual(FIREFOX_EXTENSION_CAPABILITIES);
  });

  it("safari-ios omits video and screenshot but keeps network/console/events", () => {
    const caps = getProducerCapabilities("safari-ios");
    expect(caps).toEqual(SAFARI_IOS_EXTENSION_CAPABILITIES);
    expect(caps).not.toContain("video");
    expect(caps).not.toContain("screenshot");
    expect(caps).toContain("console");
    expect(caps).toContain("network");
    expect(caps).toContain("user-events");
  });
});
