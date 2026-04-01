import type { MessageResponse, RecordingStatus } from "../types/messages";

const toggleBtn = document.getElementById("toggle-btn") as HTMLButtonElement;
const statusBar = document.getElementById("status-bar")!;
const timerEl = document.getElementById("timer")!;
const stats = document.getElementById("stats")!;
const consoleCount = document.getElementById("console-count")!;
const networkCount = document.getElementById("network-count")!;
const downloadSection = document.getElementById("download-section")!;
const uploadDriveBtn = document.getElementById("upload-drive-btn") as HTMLButtonElement;
const uploadProgress = document.getElementById("upload-progress")!;
const progressFill = document.getElementById("progress-fill") as HTMLDivElement;
const progressText = document.getElementById("progress-text") as HTMLDivElement;
const uploadResult = document.getElementById("upload-result")!;
const recordingLink = document.getElementById("recording-link") as HTMLInputElement;
const copyLinkBtn = document.getElementById("copy-link-btn")!;
const openLinkBtn = document.getElementById("open-link-btn")!;
const copyFeedback = document.getElementById("copy-feedback")!;
const errorMsg = document.getElementById("error-msg")!;

// Google Drive elements
const googleDriveStatus = document.getElementById("google-drive-status")!;
const googleDriveConnectBtn = document.getElementById("google-drive-connect-btn") as HTMLButtonElement;
const googleDriveDisconnectBtn = document.getElementById("google-drive-disconnect-btn") as HTMLButtonElement;

let pollInterval: ReturnType<typeof setInterval> | null = null;

function formatTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const sec = String(totalSec % 60).padStart(2, "0");
  return `${min}:${sec}`;
}

function updateUI(status: RecordingStatus | null): void {
  if (!status) return;

  if (status.isRecording) {
    toggleBtn.textContent = "Stop Recording";
    toggleBtn.className = "btn btn-stop";
    toggleBtn.disabled = false;
    statusBar.classList.remove("hidden");
    stats.classList.remove("hidden");
    downloadSection.classList.add("hidden");
    uploadResult.classList.add("hidden");

    const elapsed = Date.now() - status.startTime!;
    timerEl.textContent = formatTime(elapsed);
    consoleCount.textContent = String(status.consoleLogCount || 0);
    networkCount.textContent = String(status.networkRequestCount || 0);
  } else {
    toggleBtn.textContent = "Start Recording";
    toggleBtn.className = "btn btn-start";
    toggleBtn.disabled = false;
    statusBar.classList.add("hidden");
    stats.classList.add("hidden");

    if (status.hasRecording) {
      downloadSection.classList.remove("hidden");
    }
  }
}

function showError(msg: string): void {
  errorMsg.textContent = msg;
  errorMsg.classList.remove("hidden");
  setTimeout(() => errorMsg.classList.add("hidden"), 5000);
}

async function queryStatus(): Promise<void> {
  try {
    const status = await chrome.runtime.sendMessage({ action: "GET_STATUS" }) as RecordingStatus;
    updateUI(status);
  } catch {
    // Extension context invalidated
  }
}

async function updateGoogleDriveStatus(): Promise<void> {
  try {
    const result = await chrome.runtime.sendMessage({ action: "GOOGLE_DRIVE_STATUS" }) as MessageResponse & { isConnected: boolean; email?: string };
    if (result.ok && result.isConnected) {
      googleDriveStatus.textContent = result.email || "Connected";
      googleDriveConnectBtn.classList.add("hidden");
      googleDriveDisconnectBtn.classList.remove("hidden");
    } else {
      googleDriveStatus.textContent = "Not connected";
      googleDriveConnectBtn.classList.remove("hidden");
      googleDriveDisconnectBtn.classList.add("hidden");
    }
  } catch {
    googleDriveStatus.textContent = "Not connected";
    googleDriveConnectBtn.classList.remove("hidden");
    googleDriveDisconnectBtn.classList.add("hidden");
  }
}

// Toggle recording
toggleBtn.addEventListener("click", async () => {
  toggleBtn.disabled = true;
  errorMsg.classList.add("hidden");
  uploadResult.classList.add("hidden");

  const status = await chrome.runtime.sendMessage({ action: "GET_STATUS" }) as RecordingStatus;

  if (status.isRecording) {
    const result = await chrome.runtime.sendMessage({ action: "STOP_RECORDING" }) as MessageResponse;
    if (!result.ok) showError(result.error || "Failed to stop recording");
  } else {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const result = await chrome.runtime.sendMessage({ action: "START_RECORDING", tabId: tab.id }) as MessageResponse;
    if (!result.ok) showError(result.error || "Failed to start recording");
  }

  await queryStatus();
});

// Upload to Google Drive
uploadDriveBtn.addEventListener("click", async () => {
  uploadDriveBtn.disabled = true;
  uploadDriveBtn.classList.add("hidden");
  uploadProgress.classList.remove("hidden");
  uploadResult.classList.add("hidden");
  progressFill.style.width = "0%";
  progressText.textContent = "Preparing upload...";

  // Listen for progress messages
  const progressListener = (message: any) => {
    if (message.target === "offscreen" && message.type === "UPLOAD_PROGRESS" && message.data) {
      const { step, total, message: msg } = message.data;
      const percent = (step / total) * 100;
      progressFill.style.width = `${percent}%`;
      progressText.textContent = msg;
    }
  };

  chrome.runtime.onMessage.addListener(progressListener);

  try {
    const result = await chrome.runtime.sendMessage({ action: "UPLOAD_TO_GOOGLE_DRIVE" }) as MessageResponse;
    chrome.runtime.onMessage.removeListener(progressListener);

    if (result.ok) {
      recordingLink.value = result.recordingUrl || "";
      uploadResult.classList.remove("hidden");
      uploadProgress.classList.add("hidden");
    } else {
      showError(result.error || "Upload failed");
      uploadProgress.classList.add("hidden");
      uploadDriveBtn.classList.remove("hidden");
    }
  } catch (e) {
    chrome.runtime.onMessage.removeListener(progressListener);
    showError((e as Error).message);
    uploadProgress.classList.add("hidden");
    uploadDriveBtn.classList.remove("hidden");
  }

  uploadDriveBtn.disabled = false;
  uploadDriveBtn.textContent = "Upload to Google Drive";
});

// Copy link
copyLinkBtn.addEventListener("click", () => {
  navigator.clipboard.writeText(recordingLink.value);
  copyFeedback.classList.remove("hidden");
  setTimeout(() => copyFeedback.classList.add("hidden"), 2000);
});

// Open in new tab
openLinkBtn.addEventListener("click", () => {
  if (recordingLink.value) {
    chrome.tabs.create({ url: recordingLink.value });
  }
});

// Google Drive connect
googleDriveConnectBtn.addEventListener("click", async () => {
  googleDriveConnectBtn.disabled = true;

  try {
    const result = await chrome.runtime.sendMessage({ action: "GOOGLE_DRIVE_CONNECT" }) as MessageResponse;
    if (result.ok) {
      await updateGoogleDriveStatus();
    } else {
      showError(result.error || "Connection failed");
    }
  } catch (e) {
    showError((e as Error).message);
  }

  googleDriveConnectBtn.disabled = false;
});

// Google Drive disconnect
googleDriveDisconnectBtn.addEventListener("click", async () => {
  googleDriveDisconnectBtn.disabled = true;

  try {
    const result = await chrome.runtime.sendMessage({ action: "GOOGLE_DRIVE_DISCONNECT" }) as MessageResponse;
    if (result.ok) {
      await updateGoogleDriveStatus();
    } else {
      showError(result.error || "Disconnect failed");
    }
  } catch (e) {
    showError((e as Error).message);
  }

  googleDriveDisconnectBtn.disabled = false;
});

// Initial Google Drive status check
updateGoogleDriveStatus();

// Initial query and start polling
queryStatus();
pollInterval = setInterval(queryStatus, 500);
window.addEventListener("unload", () => {
  if (pollInterval) clearInterval(pollInterval);
});
