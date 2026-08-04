/**
 * Media host contract: owns video capture lifecycle and packaging document.
 *
 * Chromium uses chrome.offscreen; Firefox uses a dedicated extension page.
 */

export interface MediaHost {
  readonly kind: "offscreen" | "extension-page";

  /**
   * Start tab/screen video capture for a session. Returns first-frame wall time
   * when available (used as recording timeline anchor).
   */
  startCapture(tabId: number, sessionId: string): Promise<number | null>;

  stopCapture(discard?: boolean): Promise<void>;

  onRecordingComplete(sessionId?: string): void;

  clearActiveSession(): void;

  hydrateActiveSession(sessionId: string | null): void;

  get activeSessionId(): string | null;

  /**
   * Ensure a DOM-capable context exists for packaging (OffscreenCanvas / Blob
   * redaction). Chromium opens offscreen; Firefox opens the media page.
   */
  ensurePackagingContext(): Promise<void>;

  cleanup(): Promise<void>;
}
