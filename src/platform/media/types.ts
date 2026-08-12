/**
 * Media host contract: owns video capture lifecycle and packaging document.
 *
 * Chromium uses chrome.offscreen + tabCapture. Firefox has neither, so it uses
 * tabs.captureTab → canvas stream inside a small extension popup window
 * (windows.create type "popup") — never a tab in the user's browser strip.
 * getDisplayMedia arming remains only as a fallback.
 */

export type MediaStartCaptureOptions = {
  /**
   * Firefox legacy: stream already adopted into the media host.
   * Skip focusing the media tab / arm panel; only bind session metadata.
   */
  prearmed?: boolean;
  firstFrameAt?: number | null;
  capturedSurface?: import("../../media-pipeline/capture-surface").CapturedSurface;
  microphoneDeviceId?: string;
  speakerDeviceId?: string;
};

export interface MediaHost {
  readonly kind: "offscreen" | "extension-page";

  /**
   * Start tab/screen video capture for a session. Returns first-frame wall time
   * when available (used as recording timeline anchor).
   */
  startCapture(
    tabId: number,
    sessionId: string,
    options?: MediaStartCaptureOptions,
  ): Promise<number | null>;

  stopCapture(discard?: boolean): Promise<void>;

  onRecordingComplete(sessionId?: string): void;

  clearActiveSession(): void;

  hydrateActiveSession(sessionId: string | null): void;

  get activeSessionId(): string | null;

  /**
   * Surface metadata after capture (Firefox display-media). Chromium may omit.
   */
  readonly capturedSurface?: import("../../media-pipeline/capture-surface").CapturedSurface;

  /**
   * Ensure a DOM-capable context exists for packaging (OffscreenCanvas / Blob
   * redaction). Chromium opens offscreen; Firefox opens the media page.
   */
  ensurePackagingContext(): Promise<void>;

  cleanup(): Promise<void>;
}
