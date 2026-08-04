/**
 * Resolve the packaged browser target and coarse feature flags.
 */

import type { BrowserFeatureFlags, BrowserTarget, CaptureMode, MediaHostKind } from "./types";

declare const __BROWSER_TARGET__: BrowserTarget | undefined;

const VALID_TARGETS = new Set<BrowserTarget>(["chrome", "edge", "firefox"]);

/**
 * Compile-time browser target from esbuild `define`. Falls back to chrome so
 * unit tests and unbundled imports still resolve.
 */
export function getBrowserTarget(): BrowserTarget {
  const raw =
    typeof __BROWSER_TARGET__ !== "undefined"
      ? String(__BROWSER_TARGET__).trim().toLowerCase()
      : "";
  if (VALID_TARGETS.has(raw as BrowserTarget)) {
    return raw as BrowserTarget;
  }
  return "chrome";
}

export function isChromiumTarget(target: BrowserTarget = getBrowserTarget()): boolean {
  return target === "chrome" || target === "edge";
}

export function isFirefoxTarget(target: BrowserTarget = getBrowserTarget()): boolean {
  return target === "firefox";
}

export function getFeatureFlags(target: BrowserTarget = getBrowserTarget()): BrowserFeatureFlags {
  if (target === "firefox") {
    return {
      cdp: false,
      tabCapture: false,
      offscreen: false,
      chromeIdentityGetAuthToken: false,
      displayMediaPicker: true,
      instantReplayCdpAllowlist: false,
    };
  }

  if (target === "edge") {
    return {
      cdp: true,
      tabCapture: true,
      offscreen: true,
      chromeIdentityGetAuthToken: false,
      displayMediaPicker: false,
      instantReplayCdpAllowlist: true,
    };
  }

  return {
    cdp: true,
    tabCapture: true,
    offscreen: true,
    chromeIdentityGetAuthToken: true,
    displayMediaPicker: false,
    instantReplayCdpAllowlist: true,
  };
}

export function getCaptureMode(target: BrowserTarget = getBrowserTarget()): CaptureMode {
  return getFeatureFlags(target).cdp ? "cdp" : "in-page";
}

export function getMediaHostKind(target: BrowserTarget = getBrowserTarget()): MediaHostKind {
  return getFeatureFlags(target).offscreen ? "offscreen" : "extension-page";
}
