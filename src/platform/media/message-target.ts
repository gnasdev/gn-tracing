/**
 * Runtime message target for the media/packaging document.
 *
 * Chromium keeps historical `"offscreen"`. Firefox/macOS Safari reuse the same
 * document as a normal extension page and accept both targets so shared upload
 * code works. iOS Safari has no media host at all (`mediaKind === "none"`), so
 * calling this there is a caller bug — throw instead of silently sending a
 * message to a document that does not exist.
 */

import { getMediaHostKind } from "../detect";

export const OFFSCREEN_MESSAGE_TARGET = "offscreen";
export const MEDIA_PAGE_MESSAGE_TARGET = "media-host";

export function getMediaMessageTarget(): string {
  const kind = getMediaHostKind();
  if (kind === "none") {
    throw new Error("No media host exists on this platform (mediaKind: none).");
  }
  return kind === "extension-page" ? MEDIA_PAGE_MESSAGE_TARGET : OFFSCREEN_MESSAGE_TARGET;
}

export function isMediaMessageTarget(target: unknown): boolean {
  return target === OFFSCREEN_MESSAGE_TARGET || target === MEDIA_PAGE_MESSAGE_TARGET;
}
