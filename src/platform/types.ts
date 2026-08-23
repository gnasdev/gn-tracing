/**
 * Browser build targets and shared platform contracts.
 *
 * Build injects `__BROWSER_TARGET__`. Runtime code should prefer that constant
 * over UA sniffing so non-Chrome packages never accidentally take the Chrome
 * identity (`getAuthToken`) path.
 *
 * Chromium family: chrome | edge | opera (CDP + offscreen + tabCapture).
 * Firefox / safari: in-page + webRequest + extension-page media host.
 * safari-ios: in-page only, no media host — Safari on iOS exposes no screen
 * capture API to extension JS at all, so there is no video path to fall back to.
 */

export type BrowserTarget = "chrome" | "edge" | "opera" | "firefox" | "safari" | "safari-ios";

export type CaptureMode = "cdp" | "in-page";

export type MediaHostKind = "offscreen" | "extension-page" | "none";

export interface BrowserFeatureFlags {
  /** chrome.debugger / CDP network+console+cookies+source maps */
  cdp: boolean;
  /** chrome.tabCapture silent tab stream */
  tabCapture: boolean;
  /** chrome.offscreen document host */
  offscreen: boolean;
  /** Prefer chrome.identity.getAuthToken when brand detection says Google Chrome */
  chromeIdentityGetAuthToken: boolean;
  /** Legacy getDisplayMedia arm panel (Firefox fallback when tab-frame fails) */
  displayMediaPicker: boolean;
  /** Show Instant Replay CDP domain allowlist in settings */
  instantReplayCdpAllowlist: boolean;
  /** False only for safari-ios: no getDisplayMedia/tabCapture equivalent exists there */
  video: boolean;
  /** True only for safari-ios: in-page capture is the sole network source (no webRequest collector) */
  inPageNetworkCapture: boolean;
}

declare const __BROWSER_TARGET__: BrowserTarget | undefined;
