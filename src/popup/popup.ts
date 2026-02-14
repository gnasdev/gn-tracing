import type { MessageResponse, RecordingStatus } from "../types/messages";

const toggleBtn = document.getElementById("toggle-btn") as HTMLButtonElement;
const statusBar = document.getElementById("status-bar")!;
const timerEl = document.getElementById("timer")!;
const stats = document.getElementById("stats")!;
const consoleCount = document.getElementById("console-count")!;
const networkCount = document.getElementById("network-count")!;
const downloadSection = document.getElementById("download-section")!;
const downloadBtn = document.getElementById("download-btn") as HTMLButtonElement;
const uploadBtn = document.getElementById("upload-btn") as HTMLButtonElement;
const uploadResult = document.getElementById("upload-result")!;
const recordingLink = document.getElementById("recording-link") as HTMLInputElement;
const copyLinkBtn = document.getElementById("copy-link-btn")!;
const openLinkBtn = document.getElementById("open-link-btn")!;
const copyFeedback = document.getElementById("copy-feedback")!;
const serverUrlInput = document.getElementById("server-url") as HTMLInputElement;
const errorMsg = document.getElementById("error-msg")!;

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

// Download zip
downloadBtn.addEventListener("click", async () => {
  downloadBtn.disabled = true;
  downloadBtn.textContent = "Packaging...";

  try {
    const result = await chrome.runtime.sendMessage({ action: "DOWNLOAD_RESULTS" }) as MessageResponse;
    if (!result.ok) showError(result.error || "Failed to download");
  } catch (e) {
    showError((e as Error).message);
  }

  downloadBtn.disabled = false;
  downloadBtn.textContent = "Download (.zip)";
});

// Upload to server
uploadBtn.addEventListener("click", async () => {
  uploadBtn.disabled = true;
  uploadBtn.textContent = "Uploading...";
  uploadResult.classList.add("hidden");

  try {
    const result = await chrome.runtime.sendMessage({ action: "UPLOAD_RECORDING" }) as MessageResponse;
    if (result.ok) {
      recordingLink.value = result.recordingUrl || "";
      uploadResult.classList.remove("hidden");
    } else {
      showError(result.error || "Upload failed");
    }
  } catch (e) {
    showError((e as Error).message);
  }

  uploadBtn.disabled = false;
  uploadBtn.textContent = "Upload to Server";
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

// Server URL persistence
chrome.runtime.sendMessage({ action: "GET_SERVER_URL" }).then((res: MessageResponse) => {
  if (res && res.ok) serverUrlInput.value = res.url || "";
});

let saveTimeout: ReturnType<typeof setTimeout>;
serverUrlInput.addEventListener("input", () => {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    chrome.runtime.sendMessage({ action: "SET_SERVER_URL", url: serverUrlInput.value.trim() });
  }, 500);
});

// Initial query and start polling
queryStatus();
pollInterval = setInterval(queryStatus, 500);
window.addEventListener("unload", () => {
  if (pollInterval) clearInterval(pollInterval);
});
