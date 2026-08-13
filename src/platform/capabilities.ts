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
} from "../../packages/replay-core/src/schema/package";
import { getBrowserTarget } from "./detect";
import type { BrowserTarget } from "./types";

/** Chromium-family extension (Chrome / Edge / Opera): full CDP + tabCapture. */
export const CHROMIUM_EXTENSION_CAPABILITIES: RecordingCapability[] = [...EXTENSION_CAPABILITIES];

export function getProducerCapabilities(
  target: BrowserTarget = getBrowserTarget(),
): RecordingCapability[] {
  if (target === "firefox") {
    return [...FIREFOX_EXTENSION_CAPABILITIES];
  }
  // chrome | edge | opera share the same capability declaration.
  return [...CHROMIUM_EXTENSION_CAPABILITIES];
}

export { FIREFOX_EXTENSION_CAPABILITIES };
