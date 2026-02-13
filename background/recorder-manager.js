export class RecorderManager {
  #offscreenCreated = false;
  #recordingComplete = false;

  get hasRecording() {
    return this.#recordingComplete;
  }

  async startCapture(tabId) {
    // Check if offscreen document already exists
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
    });
    if (contexts.length === 0) {
      await chrome.offscreen.createDocument({
        url: "offscreen/offscreen.html",
        reasons: ["USER_MEDIA"],
        justification: "Tab video recording with MediaRecorder",
      });
      this.#offscreenCreated = true;
    }

    const streamId = await new Promise((resolve, reject) => {
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

  async stopCapture() {
    try {
      await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "STOP_CAPTURE",
      });
    } catch {
      // Offscreen document may already be closed
    }
  }

  onRecordingComplete() {
    this.#recordingComplete = true;
  }

  async createZip(data) {
    await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "CREATE_ZIP",
      data,
    });
  }

  async cleanup() {
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
