export class RecorderManager {
  #offscreenCreated = false;
  #stopPromiseResolve: (() => void) | null = null;
  #stopTimeoutId: ReturnType<typeof setTimeout> | null = null;
  #activeSessionId: string | null = null;

  get activeSessionId(): string | null {
    return this.#activeSessionId;
  }

  async startCapture(tabId: number, sessionId: string): Promise<void> {
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

    await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "START_CAPTURE",
      data: { streamId, sessionId },
    });

    this.#activeSessionId = sessionId;
  }

  async stopCapture(): Promise<void> {
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
        type: "STOP_CAPTURE",
      });

      await stopPromise;
    } catch {
      // Offscreen document may already be closed.
    }
  }

  async pauseCapture(): Promise<void> {
    await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "PAUSE_CAPTURE",
    });
  }

  async resumeCapture(): Promise<void> {
    await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "RESUME_CAPTURE",
    });
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

  async cleanup(): Promise<void> {
    if (this.#stopTimeoutId) {
      clearTimeout(this.#stopTimeoutId);
      this.#stopTimeoutId = null;
    }
    this.#stopPromiseResolve = null;

    if (this.#offscreenCreated) {
      try {
        await chrome.offscreen.closeDocument();
      } catch {
        // Already closed.
      }
      this.#offscreenCreated = false;
    }

    this.#activeSessionId = null;
  }
}
