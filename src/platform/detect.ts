/**
 * Resolve the packaged browser target and coarse feature flags.
 *
 * Official targets: chrome | edge | opera | firefox.
 */

import type { BrowserFeatureFlags, BrowserTarget, CaptureMode, MediaHostKind } from "./types";

declare const __BROWSER_TARGET__: BrowserTarget | undefined;

export const OFFICIAL_BROWSER_TARGETS: readonly BrowserTarget[] = [
  "chrome",
  "edge",
  "opera",
  "firefox",
] as const;

const VALID_TARGETS = new Set<BrowserTarget>(OFFICIAL_BROWSER_TARGETS);

/** Chromium-family packages share CDP capture; only Chrome may use getAuthToken. */
const CHROMIUM_TARGETS = new Set<BrowserTarget>(["chrome", "edge", "opera"]);

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

/** Chrome / Edge / Opera builds (CDP + offscreen + tabCapture). */
export function isChromiumTarget(target: BrowserTarget = getBrowserTarget()): boolean {
  return CHROMIUM_TARGETS.has(target);
}

export function isFirefoxTarget(target: BrowserTarget = getBrowserTarget()): boolean {
  return target === "firefox";
}

const FIREFOX_FLAGS: BrowserFeatureFlags = {
  cdp: false,
  tabCapture: false,
  offscreen: false,
  chromeIdentityGetAuthToken: false,
  displayMediaPicker: true,
  instantReplayCdpAllowlist: false,
};

/** Shared Chromium capture stack; auth strategy differs by brand package. */
function chromiumFlags(chromeIdentityGetAuthToken: boolean): BrowserFeatureFlags {
  return {
    cdp: true,
    tabCapture: true,
    offscreen: true,
    chromeIdentityGetAuthToken,
    displayMediaPicker: false,
    instantReplayCdpAllowlist: true,
  };
}

export function getFeatureFlags(target: BrowserTarget = getBrowserTarget()): BrowserFeatureFlags {
  if (target === "firefox") {
    return { ...FIREFOX_FLAGS };
  }
  // Only the Chrome package may attempt chrome.identity.getAuthToken (Chrome
  // extension OAuth client). Edge and Opera force web PKCE.
  return chromiumFlags(target === "chrome");
}

export function getCaptureMode(target: BrowserTarget = getBrowserTarget()): CaptureMode {
  return getFeatureFlags(target).cdp ? "cdp" : "in-page";
}

export function getMediaHostKind(target: BrowserTarget = getBrowserTarget()): MediaHostKind {
  return getFeatureFlags(target).offscreen ? "offscreen" : "extension-page";
}
