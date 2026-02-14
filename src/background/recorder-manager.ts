export class RecorderManager {
  #offscreenCreated = false;
  #recordingComplete = false;

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
      await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "STOP_CAPTURE",
      });
    } catch {
      // Offscreen document may already be closed
    }
  }

  onRecordingComplete(): void {
    this.#recordingComplete = true;
  }

  async createZip(data: Record<string, unknown>): Promise<void> {
    await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "CREATE_ZIP",
      data,
    });
  }

  async cleanup(): Promise<void> {
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
