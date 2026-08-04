/**
 * Runtime message target for the media/packaging document.
 *
 * Chromium keeps historical `"offscreen"`. Firefox reuses the same document as
 * a normal extension page and accepts both targets so shared upload code works.
 */

import { getMediaHostKind } from "../detect";

export const OFFSCREEN_MESSAGE_TARGET = "offscreen";
export const MEDIA_PAGE_MESSAGE_TARGET = "media-host";

export function getMediaMessageTarget(): string {
  return getMediaHostKind() === "extension-page"
    ? MEDIA_PAGE_MESSAGE_TARGET
    : OFFSCREEN_MESSAGE_TARGET;
}

export function isMediaMessageTarget(target: unknown): boolean {
  return target === OFFSCREEN_MESSAGE_TARGET || target === MEDIA_PAGE_MESSAGE_TARGET;
}
