/**
 * Browser-specific work that must run in the popup (user gesture context)
 * before START_RECORDING is sent to the service worker.
 *
 * Call sites should use {@link runRecordingStartPreflight} instead of
 * branching on the browser target.
 */

import { ensureRecordingHostPermission } from "../../shared/recording-host-permission";
import { getBrowserTarget, getFeatureFlags } from "../detect";
import type { BrowserTarget } from "../types";

export type RecordingStartPreflight = () => Promise<void>;

/**
 * Chromium (chrome/edge/opera): nothing required (activeTab + CDP cover host access).
 * Everything else (Firefox, macOS Safari, iOS Safari) relies on in-page content-script
 * injection for evidence, same as Firefox: optional host permission prompt so later
 * injections survive focus moves; decline is non-fatal.
 */
export function createRecordingStartPreflight(
  target: BrowserTarget = getBrowserTarget(),
): RecordingStartPreflight {
  if (!getFeatureFlags(target).cdp) {
    return async () => {
      await ensureRecordingHostPermission().catch(() => false);
    };
  }
  return async () => {
    // Chromium family: no popup-side host permission step.
  };
}

/** Convenience: build and run preflight for the current package target. */
export async function runRecordingStartPreflight(
  target: BrowserTarget = getBrowserTarget(),
): Promise<void> {
  await createRecordingStartPreflight(target)();
}
