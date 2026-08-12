/**
 * Browser build targets and shared platform contracts.
 *
 * Build injects `__BROWSER_TARGET__`. Runtime code should prefer that constant
 * over UA sniffing so non-Chrome packages never accidentally take the Chrome
 * identity (`getAuthToken`) path.
 *
 * Chromium family: chrome | edge | opera (CDP + offscreen + tabCapture).
 * Firefox: in-page + webRequest + extension-page media host.
 */

export type BrowserTarget = "chrome" | "edge" | "opera" | "firefox";

/** Official Chromium-based store/dev packages (not Firefox). */
export type ChromiumBrowserTarget = Exclude<BrowserTarget, "firefox">;

export type CaptureMode = "cdp" | "in-page";

export type MediaHostKind = "offscreen" | "extension-page";

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
}

declare const __BROWSER_TARGET__: BrowserTarget | undefined;
