export class RecorderManager {
  #offscreenCreated = false;
  #recordingComplete = false;
  #stopPromiseResolve: (() => void) | null = null;
  #stopTimeoutId: ReturnType<typeof setTimeout> | null = null;

  get hasRecording(): boolean {
    return this.#recordingComplete;
  }

  async startCapture(tabId: number): Promise<void> {
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
      data: { streamId },
    });

    this.#recordingComplete = false;
  }

  async stopCapture(): Promise<void> {
    try {
      const p = new Promise<void>((resolve) => {
        this.#stopPromiseResolve = resolve;
        // safety timeout in case the recording drops
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
      await p;
    } catch {
      // Offscreen document may already be closed
    }
  }

  onRecordingComplete(): void {
    this.#recordingComplete = true;
    if (this.#stopTimeoutId) {
      clearTimeout(this.#stopTimeoutId);
      this.#stopTimeoutId = null;
    }
    if (this.#stopPromiseResolve) {
      this.#stopPromiseResolve();
      this.#stopPromiseResolve = null;
    }
  }

  clearRecording(): void {
    this.#recordingComplete = false;
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
        // Already closed
      }
      this.#offscreenCreated = false;
    }
    this.#recordingComplete = false;
  }
}
