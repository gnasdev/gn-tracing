/**
 * Browser build targets and shared platform contracts.
 *
 * Build injects `__BROWSER_TARGET__`. Runtime code should prefer that constant
 * over UA sniffing so Edge/Firefox packages never accidentally take the Chrome
 * identity path.
 */

export type BrowserTarget = "chrome" | "edge" | "firefox";

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
  /** Video via getDisplayMedia picker (Firefox primary path) */
  displayMediaPicker: boolean;
  /** Show Instant Replay CDP domain allowlist in settings */
  instantReplayCdpAllowlist: boolean;
}

declare const __BROWSER_TARGET__: BrowserTarget | undefined;
