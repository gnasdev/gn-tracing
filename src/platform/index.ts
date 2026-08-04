/**
 * Platform entry: browser target, feature flags, and producer capabilities.
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
} from "./detect";
export { createRecordingRuntime } from "./recording-runtime/create-recording-runtime";
export type { RecordingRuntime } from "./recording-runtime/types";
export type {
  BrowserFeatureFlags,
  BrowserTarget,
  CaptureMode,
  MediaHostKind,
} from "./types";
