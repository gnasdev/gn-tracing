import type { MessageResponse, ProgressItemSnapshot, RecordingStatus, UploadState } from "../types/messages";

const GITHUB_REPO_URL = "https://github.com/gnasdev/gn-tracing";
const GITHUB_ISSUES_URL = `${GITHUB_REPO_URL}/issues`;

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
const progressMeta = document.getElementById("progress-meta") as HTMLDivElement;
const uploadItemsEl = document.getElementById("upload-items")!;
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

const githubLinkBtn = document.getElementById("github-link-btn") as HTMLButtonElement;
const contributeLinkBtn = document.getElementById("contribute-link-btn") as HTMLButtonElement;

// Storage key cho state sync từ service worker (qua chrome.storage.session)
const SERVICE_STATE_KEY = "gn_tracing_state";

// Timer interval cho recording time display
let timerInterval: ReturnType<typeof setInterval> | null = null;

// Load state từ service worker storage
async function loadStateFromStorage(): Promise<{ recording?: RecordingStatus; upload?: UploadState; googleDrive?: { isConnected: boolean } } | null> {
  try {
    const result = await chrome.storage.session.get(SERVICE_STATE_KEY);
    return result[SERVICE_STATE_KEY] || null;
  } catch {
    return null;
  }
}

// Subscribe to storage changes from service worker
function subscribeToStateChanges(callback: (state: { recording?: RecordingStatus; upload?: UploadState; googleDrive?: { isConnected: boolean } }) => void): () => void {
  const listener = (changes: { [key: string]: chrome.storage.StorageChange }) => {
    if (changes[SERVICE_STATE_KEY]) {
      callback(changes[SERVICE_STATE_KEY].newValue);
    }
  };
  chrome.storage.session.onChanged.addListener(listener);
  return () => chrome.storage.session.onChanged.removeListener(listener);
}

// Start timer cho recording
function startRecordingTimer(startTime: number) {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    const elapsed = Date.now() - startTime;
    timerEl.textContent = formatTime(elapsed);
  }, 1000);
}

// Stop timer
function stopRecordingTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function formatTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const sec = String(totalSec % 60).padStart(2, "0");
  return `${min}:${sec}`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const digits = value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function renderUploadProgress(progress: {
  percent?: number;
  uploadedBytes?: number;
  totalBytes?: number;
} | null): void {
  const percent = Math.max(0, Math.min(100, progress?.percent ?? 0));
  const uploadedBytes = Math.max(0, progress?.uploadedBytes ?? 0);
  const totalBytes = Math.max(0, progress?.totalBytes ?? 0);

  progressFill.style.width = `${percent}%`;
  progressText.textContent = "Uploading recording...";
  progressMeta.textContent = `${formatBytes(uploadedBytes)} / ${formatBytes(totalBytes)} (${percent.toFixed(1)}%)`;
}

function getProgressStatusLabel(status: ProgressItemSnapshot["status"]): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "uploading":
      return "Uploading";
    case "uploaded":
      return "Uploaded";
    case "skipped":
      return "Skipped";
    case "failed":
      return "Failed";
    default:
      return status;
  }
}

function renderUploadItems(items: ProgressItemSnapshot[] | undefined): void {
  const safeItems = Array.isArray(items) ? items : [];
  uploadItemsEl.innerHTML = safeItems.map((item) => {
    const totalBytes = Math.max(0, item.totalBytes || 0);
    const loadedBytes = Math.max(0, item.loadedBytes || 0);
    const percent = totalBytes > 0 ? Math.max(0, Math.min(100, item.percent || 0)) : 0;
    const percentLabel = totalBytes > 0 ? `${percent.toFixed(1)}%` : "—";
    const sizeLabel = `${formatBytes(loadedBytes)} / ${formatBytes(totalBytes)}`;
    return `
      <div class="progress-item">
        <div class="progress-item-header">
          <span class="progress-item-label">${item.label}</span>
          <span class="progress-item-status">${getProgressStatusLabel(item.status)}</span>
        </div>
        <div class="progress-item-meta">
          <span>${percentLabel}</span>
          <span>${sizeLabel}</span>
        </div>
      </div>
    `;
  }).join("");
}

function updateUI(status: RecordingStatus | null): void {
  if (!status) return;

  if (status.phase === "recording") {
    toggleBtn.textContent = "Stop Recording";
    toggleBtn.className = "btn btn-stop";
    toggleBtn.disabled = false;
    statusBar.classList.remove("hidden");
    stats.classList.remove("hidden");
    downloadSection.classList.add("hidden");
    uploadResult.classList.add("hidden");

    // Start timer if not already running
    if (!timerInterval && status.startTime) {
      startRecordingTimer(status.startTime);
    }

    consoleCount.textContent = String(status.consoleLogCount || 0);
    networkCount.textContent = String(status.networkRequestCount || 0);
  } else {
    toggleBtn.textContent = "Start Recording";
    toggleBtn.className = "btn btn-start";
    toggleBtn.disabled = false;
    statusBar.classList.add("hidden");
    stats.classList.add("hidden");
    stopRecordingTimer();

    if (status.hasRecording) {
      downloadSection.classList.remove("hidden");
    } else {
      downloadSection.classList.add("hidden");
    }

    if (status.phase === "interrupted") {
      uploadResult.classList.add("hidden");
    }
  }
}

function updateUploadUI(uploadState: UploadState | null): void {
  if (!uploadState) return;

  // If upload is in progress, show progress
  if (uploadState.isUploading) {
    uploadDriveBtn.classList.add("hidden");
    uploadProgress.classList.remove("hidden");
    uploadResult.classList.add("hidden");
    renderUploadProgress({
      percent: uploadState.progress,
      uploadedBytes: uploadState.uploadedBytes,
      totalBytes: uploadState.totalBytes,
    });
    renderUploadItems(uploadState.items);
    return;
  }

  // If upload completed successfully, show result
  if (uploadState.recordingUrl) {
    uploadDriveBtn.classList.add("hidden");
    uploadProgress.classList.add("hidden");
    uploadResult.classList.remove("hidden");
    recordingLink.value = uploadState.recordingUrl;
    return;
  }

  // If upload failed, show error and reset button
  if (uploadState.error) {
    uploadProgress.classList.add("hidden");
    uploadDriveBtn.classList.remove("hidden");
    uploadDriveBtn.disabled = false;
    showError(uploadState.error);
  } else {
    // Reset to default state - show upload button
    uploadProgress.classList.add("hidden");
    uploadDriveBtn.classList.remove("hidden");
    uploadDriveBtn.disabled = false;
  }
}

function updateGoogleDriveUI(isConnected: boolean): void {
  if (isConnected) {
    googleDriveStatus.textContent = "Connected";
    googleDriveConnectBtn.classList.add("hidden");
    googleDriveDisconnectBtn.classList.remove("hidden");
  } else {
    googleDriveStatus.textContent = "Not connected";
    googleDriveConnectBtn.classList.remove("hidden");
    googleDriveDisconnectBtn.classList.add("hidden");
  }
}

async function refreshGoogleDriveStatus(): Promise<void> {
  try {
    const result = await chrome.runtime.sendMessage({ action: "GOOGLE_DRIVE_STATUS" }) as MessageResponse & { isConnected?: boolean };
    if (result.ok) {
      updateGoogleDriveUI(Boolean(result.isConnected));
    }
  } catch {
    // Keep last known UI state if service worker is still warming up
  }
}

function showError(msg: string): void {
  errorMsg.textContent = msg;
  errorMsg.classList.remove("hidden");
  setTimeout(() => errorMsg.classList.add("hidden"), 5000);
}

// Handle state update từ storage
function handleStateUpdate(state: { recording?: RecordingStatus; upload?: UploadState; googleDrive?: { isConnected: boolean } }): void {
  if (state.recording) {
    updateUI(state.recording);
  }
  if (state.upload && state.recording?.phase !== "recording") {
    updateUploadUI(state.upload);
  }
  if (state.googleDrive) {
    updateGoogleDriveUI(state.googleDrive.isConnected);
  }
}

// Toggle recording
toggleBtn.addEventListener("click", async () => {
  toggleBtn.disabled = true;
  errorMsg.classList.add("hidden");
  uploadResult.classList.add("hidden");

  try {
    const currentState = await loadStateFromStorage();
    const isRecording = currentState?.recording?.isRecording ?? false;

    if (isRecording) {
      const result = await chrome.runtime.sendMessage({ action: "STOP_RECORDING" }) as MessageResponse;
      if (!result.ok) showError(result.error || "Failed to stop recording");
    } else {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const result = await chrome.runtime.sendMessage({ action: "START_RECORDING", tabId: tab.id }) as MessageResponse;
      if (!result.ok) showError(result.error || "Failed to start recording");
    }
  } catch (e) {
    showError((e as Error).message);
  } finally {
    toggleBtn.disabled = false;
  }
});

// Upload to Google Drive
uploadDriveBtn.addEventListener("click", async () => {
  uploadDriveBtn.disabled = true;
  uploadDriveBtn.classList.add("hidden");
  uploadProgress.classList.remove("hidden");
  uploadResult.classList.add("hidden");
  progressFill.style.width = "0%";
      progressText.textContent = "Uploading recording...";
  progressMeta.textContent = "0 B / 0 B (0.0%)";
  uploadItemsEl.innerHTML = "";

  // Listen for progress messages
  const progressListener = (message: any) => {
    if (message.target === "offscreen" && message.type === "UPLOAD_PROGRESS" && message.data) {
      const {
        percent,
        uploadedBytes,
        totalBytes,
        items,
      } = message.data;
      renderUploadProgress({ percent, uploadedBytes, totalBytes });
      renderUploadItems(items);
    }
  };

  chrome.runtime.onMessage.addListener(progressListener);

  // Cleanup function để đảm bảo listener được xóa
  const cleanup = () => {
    chrome.runtime.onMessage.removeListener(progressListener);
  };

  try {
    const result = await chrome.runtime.sendMessage({ action: "UPLOAD_TO_GOOGLE_DRIVE" }) as MessageResponse;
    cleanup();

    if (result.ok) {
      recordingLink.value = result.recordingUrl || "";
      uploadResult.classList.remove("hidden");
      uploadProgress.classList.add("hidden");
    } else {
      showError(result.error || "Upload failed");
      uploadProgress.classList.add("hidden");
      uploadDriveBtn.classList.remove("hidden");
      uploadDriveBtn.disabled = false;
      uploadDriveBtn.textContent = "Upload to Google Drive";
    }
  } catch (e) {
    cleanup();
    showError((e as Error).message);
    uploadProgress.classList.add("hidden");
    uploadDriveBtn.classList.remove("hidden");
    uploadDriveBtn.disabled = false;
    uploadDriveBtn.textContent = "Upload to Google Drive";
  }
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

// Google Drive connect - open auth page
googleDriveConnectBtn.addEventListener("click", async () => {
  // Open drive auth page in a new tab
  chrome.tabs.create({
    url: chrome.runtime.getURL("drive-auth/drive-auth.html"),
  });

  // Close popup
  window.close();
});

// Google Drive disconnect
googleDriveDisconnectBtn.addEventListener("click", async () => {
  googleDriveDisconnectBtn.disabled = true;

  try {
    const result = await chrome.runtime.sendMessage({ action: "GOOGLE_DRIVE_DISCONNECT" }) as MessageResponse;
    if (!result.ok) {
      showError(result.error || "Disconnect failed");
    }
    // State sẽ được cập nhật qua storage change event
  } catch (e) {
    showError((e as Error).message);
  } finally {
    googleDriveDisconnectBtn.disabled = false;
  }
});

function openExternalUrl(url: string): void {
  chrome.tabs.create({ url });
}

// Initialize popup - load state từ storage và subscribe đến changes
async function initPopup(): Promise<void> {
  // Load initial state
  const initialState = await loadStateFromStorage();
  if (initialState) {
    handleStateUpdate(initialState);
  }
  await refreshGoogleDriveStatus();

  // Subscribe to storage changes từ service worker
  const unsubscribe = subscribeToStateChanges((newState) => {
    handleStateUpdate(newState);
  });

  // Cleanup khi popup đóng
  window.addEventListener("unload", () => {
    stopRecordingTimer();
    unsubscribe();
  });
}

// Start
githubLinkBtn.addEventListener("click", () => {
  openExternalUrl(GITHUB_REPO_URL);
});

contributeLinkBtn.addEventListener("click", () => {
  openExternalUrl(GITHUB_ISSUES_URL);
});

initPopup();
