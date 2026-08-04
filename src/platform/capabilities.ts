/**
 * Recording capability sets per browser producer path.
 *
 * Package metadata must declare what the producer can actually capture so the
 * player/MCP never assume CDP-quality network on a Firefox package.
 */

import type { RecordingCapability } from "../../packages/replay-core/src/schema/package";
import {
  EXTENSION_CAPABILITIES,
  FIREFOX_EXTENSION_CAPABILITIES,
  SDK_CAPABILITIES,
} from "../../packages/replay-core/src/schema/package";
import { getBrowserTarget } from "./detect";
import type { BrowserTarget } from "./types";

/** Chromium extension (Chrome + Edge): full CDP + silent tabCapture path. */
export const CHROMIUM_EXTENSION_CAPABILITIES: RecordingCapability[] = [...EXTENSION_CAPABILITIES];

export function getProducerCapabilities(
  target: BrowserTarget = getBrowserTarget(),
): RecordingCapability[] {
  if (target === "firefox") {
    return [...FIREFOX_EXTENSION_CAPABILITIES];
  }
  return [...CHROMIUM_EXTENSION_CAPABILITIES];
}

export { EXTENSION_CAPABILITIES, FIREFOX_EXTENSION_CAPABILITIES, SDK_CAPABILITIES };
