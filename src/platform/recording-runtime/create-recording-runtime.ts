/**
 * Factory for the browser-specific full-record runtime.
 */

import type { StorageManager } from "../../background/storage-manager";
import { getBrowserTarget } from "../detect";
import { ChromiumRecordingRuntime } from "./chromium-runtime";
import { FirefoxRecordingRuntime } from "./firefox-runtime";
import type { RecordingRuntime } from "./types";

/**
 * When `browserTarget` is omitted, uses the build-time `__BROWSER_TARGET__`.
 * Chromium family (chrome/edge/opera) shares {@link ChromiumRecordingRuntime};
 * tests pass an explicit target so they can assert Firefox never constructs CDP.
 */
export function createRecordingRuntime(
  storage: StorageManager,
  browserTarget = getBrowserTarget(),
): RecordingRuntime {
  if (browserTarget === "firefox") {
    return new FirefoxRecordingRuntime(storage);
  }
  return new ChromiumRecordingRuntime(storage);
}

export type { RecordingRuntime } from "./types";
