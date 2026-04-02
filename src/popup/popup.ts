import type { MessageResponse, RecordingStatus, UploadState, PlayerConfig } from "../types/messages";

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

// Player Config elements
const playerHostDisplay = document.getElementById("player-host-display") as HTMLDivElement;
const playerEditContainer = document.getElementById("player-edit-container") as HTMLDivElement;
const playerHostValue = document.getElementById("player-host-value") as HTMLSpanElement;
const editPlayerBtn = document.getElementById("edit-player-btn") as HTMLButtonElement;
const playerHostInput = document.getElementById("player-host-input") as HTMLInputElement;
const savePlayerConfigBtn = document.getElementById("save-player-config-btn") as HTMLButtonElement;
const cancelPlayerConfigBtn = document.getElementById("cancel-player-config-btn") as HTMLButtonElement;

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
  }
}

function updateUploadUI(uploadState: UploadState | null): void {
  if (!uploadState) return;

  // If upload is in progress, show progress
  if (uploadState.isUploading) {
    uploadDriveBtn.classList.add("hidden");
    uploadProgress.classList.remove("hidden");
    uploadResult.classList.add("hidden");
    progressFill.style.width = `${uploadState.progress}%`;
    progressText.textContent = uploadState.message || "Uploading...";
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
  if (state.upload) {
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

// Default player host from build-time env
const DEFAULT_PLAYER_HOST = typeof process !== 'undefined' && process.env?.PLAYER_HOST_URL
  ? process.env.PLAYER_HOST_URL
  : "";

// Current saved player host value
let currentPlayerHost: string | null = null;

// Toggle to edit mode
function enterEditMode() {
  playerEditContainer.classList.remove("hidden");
  // Pre-fill with current value
  playerHostInput.value = currentPlayerHost || "";
  playerHostInput.focus();
}

// Toggle to display mode
function exitEditMode() {
  playerEditContainer.classList.add("hidden");
}

// Update display value
function updatePlayerDisplay(value: string | null) {
  currentPlayerHost = value;
  if (value) {
    playerHostValue.textContent = value;
    playerHostValue.title = value;
  } else {
    playerHostValue.textContent = "Built-in player";
    playerHostValue.title = "Using extension built-in player";
  }
}

// Player Config - Load config when popup opens
async function loadPlayerConfig(): Promise<void> {
  try {
    const response = await chrome.runtime.sendMessage({ action: "GET_PLAYER_CONFIG" }) as MessageResponse;
    if (response.ok) {
      const savedValue = response.playerHostUrl;
      // savedValue === null: user explicitly wants built-in
      // savedValue === "": no user config, check .env default
      // savedValue has value: user custom config
      let effectiveValue: string | null;
      if (savedValue === null) {
        effectiveValue = null; // Built-in
      } else if (savedValue) {
        effectiveValue = savedValue; // User custom
      } else if (DEFAULT_PLAYER_HOST) {
        effectiveValue = DEFAULT_PLAYER_HOST; // .env default
      } else {
        effectiveValue = null; // No config
      }
      updatePlayerDisplay(effectiveValue);
    }
  } catch (e) {
    console.error("Failed to load player config:", e);
    updatePlayerDisplay(null);
  }
}

// Player Config - Edit button
editPlayerBtn.addEventListener("click", () => {
  enterEditMode();
});

// Player Config - Save config
savePlayerConfigBtn.addEventListener("click", async () => {
  const url = playerHostInput.value.trim();

  // Validate URL if not empty
  if (url) {
    try {
      const parsed = new URL(url);
      if (!parsed.protocol.startsWith("http")) {
        showError("URL must start with http:// or https://");
        return;
      }
    } catch {
      showError("Invalid URL");
      return;
    }
  }

  const config: PlayerConfig = { playerHostUrl: url || null };

  try {
    const result = await chrome.runtime.sendMessage({
      action: "SET_PLAYER_CONFIG",
      data: config,
    }) as MessageResponse;

    if (result.ok) {
      updatePlayerDisplay(url || null);
      exitEditMode();
      showSuccess(url ? "Player host saved!" : "Using built-in player");
    } else {
      showError(result.error || "Failed to save");
    }
  } catch (e) {
    showError((e as Error).message);
  }
});

// Player Config - Cancel edit
cancelPlayerConfigBtn.addEventListener("click", () => {
  exitEditMode();
});

function showSuccess(msg: string): void {
  errorMsg.textContent = msg;
  errorMsg.className = "success-msg";
  setTimeout(() => {
    errorMsg.className = "hidden";
  }, 3000);
}

// Initialize popup - load state từ storage và subscribe đến changes
async function initPopup(): Promise<void> {
  // Load initial state
  const initialState = await loadStateFromStorage();
  if (initialState) {
    handleStateUpdate(initialState);
  }

  // Load player config
  await loadPlayerConfig();

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
initPopup();
