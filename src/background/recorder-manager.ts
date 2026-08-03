/**
 * Coordinates offscreen-document recording lifecycle from the service worker.
 */
export class RecorderManager {
  /**
   * Owns the service-worker side of tab capture.
   *
   * The actual MediaRecorder lives in the offscreen document because MV3 service
   * workers cannot hold DOM media objects. This manager only creates/reuses the
   * offscreen document, forwards lifecycle commands, and waits briefly for the
   * offscreen stop acknowledgement before allowing the service worker flow to
   * continue.
   */
  #offscreenCreated = false;
  #stopPromiseResolve: (() => void) | null = null;
  #stopTimeoutId: ReturnType<typeof setTimeout> | null = null;
  #activeSessionId: string | null = null;

  get activeSessionId(): string | null {
    return this.#activeSessionId;
  }

  async startCapture(tabId: number, sessionId: string): Promise<number | null> {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    });

    if (contexts.length === 0) {
      await chrome.offscreen.createDocument({
        url: "offscreen/offscreen.html",
        reasons: [chrome.offscreen.Reason.USER_MEDIA],
        justification: "Tab video recording with MediaRecorder",
      });
      this.#offscreenCreated = true;
    }

    const streamId = await new Promise<string>((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(id);
        }
      });
    });

    const response = (await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "START_CAPTURE",
      data: { streamId, sessionId },
    })) as { ok: boolean; data?: { firstFrameAt?: number | null } } | undefined;

    this.#activeSessionId = sessionId;
    return response?.data?.firstFrameAt ?? null;
  }

  async stopCapture(discard = false): Promise<void> {
    try {
      const stopPromise = new Promise<void>((resolve) => {
        this.#stopPromiseResolve = resolve;
        this.#stopTimeoutId = setTimeout(() => {
          this.#stopTimeoutId = null;
          this.#stopPromiseResolve = null;
          resolve();
        }, 3000);
      });

      await chrome.runtime.sendMessage({
        target: "offscreen",
        type: discard ? "DISCARD_CAPTURE" : "STOP_CAPTURE",
      });

      await stopPromise;
    } catch {
      // Offscreen document may already be closed.
    }
  }

  onRecordingComplete(sessionId?: string): void {
    if (this.#activeSessionId && sessionId && sessionId !== this.#activeSessionId) {
      return;
    }

    if (this.#stopTimeoutId) {
      clearTimeout(this.#stopTimeoutId);
      this.#stopTimeoutId = null;
    }

    if (this.#stopPromiseResolve) {
      this.#stopPromiseResolve();
      this.#stopPromiseResolve = null;
    }
  }

  clearActiveSession(): void {
    this.#activeSessionId = null;
  }

  hydrateActiveSession(sessionId: string | null): void {
    this.#activeSessionId = sessionId;
  }

  async closeOffscreenDocument(): Promise<void> {
    if (this.#stopTimeoutId) {
      clearTimeout(this.#stopTimeoutId);
      this.#stopTimeoutId = null;
    }
    this.#stopPromiseResolve = null;

    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    });

    if (contexts.length > 0) {
      await chrome.offscreen.closeDocument();
    }

    this.#offscreenCreated = false;
    this.#activeSessionId = null;
  }

  async cleanup(): Promise<void> {
    try {
      await this.closeOffscreenDocument();
    } catch {
      // Already closed.
    }
  }
}
