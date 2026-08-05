/**
 * Chromium-family media host (Chrome / Edge / Opera) backed by
 * chrome.offscreen + tabCapture.
 */

import { RecorderManager } from "../../background/recorder-manager";
import type { MediaHost } from "./types";

export class OffscreenMediaHost implements MediaHost {
  readonly kind = "offscreen" as const;
  readonly #recorder = new RecorderManager();

  get activeSessionId(): string | null {
    return this.#recorder.activeSessionId;
  }

  startCapture(
    tabId: number,
    sessionId: string,
    _options?: import("./types").MediaStartCaptureOptions,
  ): Promise<number | null> {
    return this.#recorder.startCapture(tabId, sessionId);
  }

  stopCapture(discard = false): Promise<void> {
    return this.#recorder.stopCapture(discard);
  }

  onRecordingComplete(sessionId?: string): void {
    this.#recorder.onRecordingComplete(sessionId);
  }

  clearActiveSession(): void {
    this.#recorder.clearActiveSession();
  }

  hydrateActiveSession(sessionId: string | null): void {
    this.#recorder.hydrateActiveSession(sessionId);
  }

  async ensurePackagingContext(): Promise<void> {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    });
    if (contexts.length > 0) {
      return;
    }
    await chrome.offscreen.createDocument({
      url: "offscreen/offscreen.html",
      reasons: [chrome.offscreen.Reason.BLOBS],
      justification: "Redacting and packaging an annotated screenshot report",
    });
  }

  cleanup(): Promise<void> {
    return this.#recorder.cleanup();
  }
}
