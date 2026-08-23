/**
 * Factory for the browser-specific full-record runtime.
 */

import type { StorageManager } from "../../background/storage-manager";
import { getBrowserTarget } from "../detect";
import { ChromiumRecordingRuntime } from "./chromium-runtime";
import { FirefoxRecordingRuntime } from "./firefox-runtime";
import { SafariIosRecordingRuntime } from "./safari-ios-runtime";
import { SafariRecordingRuntime } from "./safari-runtime";
import type { RecordingRuntime } from "./types";

/**
 * When `browserTarget` is omitted, uses the build-time `__BROWSER_TARGET__`.
 * Chromium family (chrome/edge/opera) shares {@link ChromiumRecordingRuntime};
 * tests pass an explicit target so they can assert Firefox/Safari never
 * construct CDP and safari-ios never constructs a media host.
 */
export function createRecordingRuntime(
  storage: StorageManager,
  browserTarget = getBrowserTarget(),
): RecordingRuntime {
  if (browserTarget === "safari-ios") {
    return new SafariIosRecordingRuntime(storage);
  }
  if (browserTarget === "safari") {
    return new SafariRecordingRuntime(storage);
  }
  if (browserTarget === "firefox") {
    return new FirefoxRecordingRuntime(storage);
  }
  return new ChromiumRecordingRuntime(storage);
}

export type { RecordingRuntime } from "./types";
