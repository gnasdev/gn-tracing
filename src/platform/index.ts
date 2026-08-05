/**
 * Platform entry: browser target, feature flags, and producer capabilities.
 *
 * Official packages: chrome | edge | opera | firefox. Prefer factories over browser ifs.
 */

export {
  CHROMIUM_EXTENSION_CAPABILITIES,
  EXTENSION_CAPABILITIES,
  FIREFOX_EXTENSION_CAPABILITIES,
  getProducerCapabilities,
  SDK_CAPABILITIES,
} from "./capabilities";
export {
  getBrowserTarget,
  getCaptureMode,
  getFeatureFlags,
  getMediaHostKind,
  isChromiumTarget,
  isFirefoxTarget,
  OFFICIAL_BROWSER_TARGETS,
} from "./detect";
export type { RecordingStartPreflight } from "./preflight/recording-start-preflight";
export {
  createRecordingStartPreflight,
  runRecordingStartPreflight,
} from "./preflight/recording-start-preflight";
export { createRecordingRuntime } from "./recording-runtime/create-recording-runtime";
export type { RecordingRuntime } from "./recording-runtime/types";
export type {
  BrowserFeatureFlags,
  BrowserTarget,
  CaptureMode,
  ChromiumBrowserTarget,
  MediaHostKind,
} from "./types";
