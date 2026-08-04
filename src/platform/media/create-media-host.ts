/**
 * Factory for the browser-specific media host.
 */

import { getMediaHostKind } from "../detect";
import { OffscreenMediaHost } from "./offscreen-host";
import { ExtensionPageMediaHost } from "./page-host";
import type { MediaHost } from "./types";

export function createMediaHost(): MediaHost {
  if (getMediaHostKind() === "extension-page") {
    return new ExtensionPageMediaHost();
  }
  return new OffscreenMediaHost();
}

export type { MediaHost } from "./types";
