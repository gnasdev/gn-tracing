import type {
  MessageResponse,
  PopupState,
  ProgressItemSnapshot,
  RecordingSessionSummary,
  RecordingStatus,
  UploadHistoryEntry,
  UploadSettings,
} from "../types/messages";
import {
  HISTORY_PAGE_PATH,
  escapeHtml,
  formatDateTime,
  formatPageLabel,
  formatTime,
  getVisibleUploadHistory,
  handleUploadHistoryAction,
  renderUploadHistoryList,
} from "../shared/upload-history-ui";

const GITHUB_REPO_URL = "https://github.com/gnasdev/gn-tracing";
const GITHUB_ISSUES_URL = `${GITHUB_REPO_URL}/issues`;
const SERVICE_STATE_KEY = "gn_tracing_state";

const toggleBtn = document.getElementById("toggle-btn") as HTMLButtonElement;
const pauseResumeBtn = document.getElementById("pause-resume-btn") as HTMLButtonElement;
const reloadBtn = document.getElementById("reload-btn") as HTMLButtonElement;
const statusBar = document.getElementById("status-bar")!;
const timerEl = document.getElementById("timer")!;
const stats = document.getElementById("stats")!;
const consoleCount = document.getElementById("console-count")!;
const networkCount = document.getElementById("network-count")!;
const sessionList = document.getElementById("session-list")!;
const errorMsg = document.getElementById("error-msg")!;
const toastEl = document.getElementById("toast")!;

const googleDriveStatus = document.getElementById("google-drive-status")!;
const googleDriveConnectBtn = document.getElementById("google-drive-connect-btn") as HTMLButtonElement;
const googleDriveDisconnectBtn = document.getElementById("google-drive-disconnect-btn") as HTMLButtonElement;
const googleDriveFolderInput = document.getElementById("google-drive-folder-input") as HTMLInputElement;
const googleDriveFolderHint = document.getElementById("google-drive-folder-hint")!;
const saveFolderBtn = document.getElementById("save-folder-btn") as HTMLButtonElement;
const uploadHistoryList = document.getElementById("upload-history-list")!;
const uploadHistoryMoreBtn = document.getElementById("upload-history-more-btn") as HTMLButtonElement;

const githubLinkBtn = document.getElementById("github-link-btn") as HTMLButtonElement;
const contributeLinkBtn = document.getElementById("contribute-link-btn") as HTMLButtonElement;

let timerInterval: ReturnType<typeof setInterval> | null = null;
let toastTimeout: ReturnType<typeof setTimeout> | null = null;
let isEditingFolder = false;

function getEditIcon(): string {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="m4 15.75 9.81-9.81 4.25 4.25L8.25 20H4v-4.25Zm11.23-11.23a1 1 0 0 1 1.41 0l2.83 2.83a1 1 0 0 1 0 1.41l-.71.71-4.24-4.24.71-.71Z" fill="currentColor"/>
    </svg>
  `;
}

function getSaveIcon(): string {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M5 4h11l3 3v13H5V4Zm2 0v5h8V4H7Zm0 9v5h10v-5H7Z" fill="currentColor"/>
    </svg>
  `;
}

function getFolderDisplayValue(folderInput: string | null | undefined): string {
  const trimmed = (folderInput || "").trim();
  return trimmed || "/";
}

function getFolderSaveValue(folderInput: string): string {
  const trimmed = folderInput.trim();
  return trimmed === "/" ? "" : trimmed;
}

function setFolderEditingState(nextIsEditing: boolean): void {
  isEditingFolder = nextIsEditing;
  googleDriveFolderInput.disabled = !nextIsEditing;
  const buttonLabel = nextIsEditing ? "Save upload folder" : "Edit upload folder";
  saveFolderBtn.innerHTML = nextIsEditing ? getSaveIcon() : getEditIcon();
  saveFolderBtn.setAttribute("aria-label", buttonLabel);
  saveFolderBtn.setAttribute("title", buttonLabel);

  if (nextIsEditing) {
    googleDriveFolderInput.focus();
    googleDriveFolderInput.select();
  }
}

async function loadStateFromStorage(): Promise<PopupState | null> {
  try {
    const result = await chrome.storage.session.get(SERVICE_STATE_KEY);
    return result[SERVICE_STATE_KEY] || null;
  } catch {
    return null;
  }
}

function subscribeToStateChanges(callback: (state: PopupState) => void): () => void {
  const listener = (changes: { [key: string]: chrome.storage.StorageChange }) => {
    if (changes[SERVICE_STATE_KEY]?.newValue) {
      callback(changes[SERVICE_STATE_KEY].newValue as PopupState);
    }
  };
  chrome.storage.session.onChanged.addListener(listener);
  return () => chrome.storage.session.onChanged.removeListener(listener);
}

function startRecordingTimer(initialElapsedMs: number): void {
  if (timerInterval) {
    clearInterval(timerInterval);
  }
  const timerStart = Date.now() - initialElapsedMs;
  timerInterval = setInterval(() => {
    timerEl.textContent = formatTime(Date.now() - timerStart);
  }, 1000);
}

function stopRecordingTimer(): void {
  if (!timerInterval) {
    return;
  }
  clearInterval(timerInterval);
  timerInterval = null;
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

function showError(message: string): void {
  errorMsg.textContent = message;
  errorMsg.className = "";
  errorMsg.classList.remove("hidden");
  setTimeout(() => errorMsg.classList.add("hidden"), 5000);
}

function showSuccess(message: string): void {
  showToast(message);
}

function showToast(message: string): void {
  toastEl.textContent = message;
  toastEl.classList.remove("hidden");
  if (toastTimeout) {
    clearTimeout(toastTimeout);
  }
  toastTimeout = setTimeout(() => {
    toastEl.classList.add("hidden");
    toastTimeout = null;
  }, 1800);
}

function getProgressStatusLabel(status: ProgressItemSnapshot["status"]): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "uploading":
      return "Uploading";
    case "uploaded":
      return "Uploaded";
    case "failed":
      return "Failed";
    case "skipped":
      return "Skipped";
    default:
      return status;
  }
}

function getProgressItemVisual(status: ProgressItemSnapshot["status"]): {
  statusClass: string;
  fillPercent: number;
} {
  switch (status) {
    case "uploaded":
      return { statusClass: "is-success", fillPercent: 100 };
    case "failed":
      return { statusClass: "is-failed", fillPercent: 100 };
    case "skipped":
      return { statusClass: "is-skipped", fillPercent: 100 };
    case "uploading":
      return { statusClass: "is-active", fillPercent: -1 };
    case "queued":
    default:
      return { statusClass: "is-queued", fillPercent: 0 };
  }
}

function renderSessionActionButton(params: {
  action: string;
  label: string;
  icon: string;
  attrName: string;
  attrValue: string;
}): string {
  return `
    <button
      type="button"
      class="session-icon-button"
      data-action="${params.action}"
      ${params.attrName}="${escapeHtml(params.attrValue)}"
      aria-label="${escapeHtml(params.label)}"
      title="${escapeHtml(params.label)}"
    >
      ${params.icon}
    </button>
  `;
}

function getUploadIcon(): string {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 3 7.5 7.5l1.41 1.41L11 6.83V16h2V6.83l2.09 2.08 1.41-1.41L12 3Zm-7 14h14v4H5v-4Z" fill="currentColor"/>
    </svg>
  `;
}

function getReplayIcon(): string {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M8 6.82v10.36c0 .79.87 1.27 1.54.84l8.14-5.18a1 1 0 0 0 0-1.68L9.54 5.98A1 1 0 0 0 8 6.82Z" fill="currentColor"/>
    </svg>
  `;
}

function getFolderIcon(): string {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M3 7a2 2 0 0 1 2-2h4.17c.53 0 1.04.21 1.41.59l1.83 1.82c.19.19.44.29.71.29H19a2 2 0 0 1 2 2v1H3V7Zm0 5h18l-1.6 6.4A2 2 0 0 1 17.46 20H6.54a2 2 0 0 1-1.94-1.6L3 12Z" fill="currentColor"/>
    </svg>
  `;
}

function getCopyIcon(): string {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M9 9a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2V9Zm-5 4V6a2 2 0 0 1 2-2h7v2H6v7H4Z" fill="currentColor"/>
    </svg>
  `;
}

function getDeleteIcon(): string {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm1 7h2v7h-2v-7Zm4 0h2v7h-2v-7ZM7 10h2v7H7v-7Zm-1 10a2 2 0 0 1-2-2V8h16v10a2 2 0 0 1-2 2H6Z" fill="currentColor"/>
    </svg>
  `;
}

function renderProgressItems(items: ProgressItemSnapshot[] | undefined): string {
  const safeItems = Array.isArray(items) ? items : [];
  return safeItems.map((item) => {
    const totalBytes = Math.max(0, item.totalBytes || 0);
    const loadedBytes = Math.max(0, item.loadedBytes || 0);
    const percent = totalBytes > 0 ? Math.max(0, Math.min(100, item.percent || 0)) : 0;
    const visual = getProgressItemVisual(item.status);
    const fillPercent = visual.fillPercent >= 0 ? visual.fillPercent : percent;
    const percentLabel = totalBytes > 0 ? `${percent.toFixed(1)}%` : "—";
    return `
      <div class="progress-item ${visual.statusClass}" style="--item-progress:${fillPercent}%;">
        <div class="progress-item-header">
          <span class="progress-item-label">${escapeHtml(item.label)}</span>
          <span class="progress-item-status">${escapeHtml(getProgressStatusLabel(item.status))}</span>
        </div>
        <div class="progress-item-meta">
          <span>${percentLabel}</span>
          <span>${formatBytes(loadedBytes)} / ${formatBytes(totalBytes)}</span>
        </div>
      </div>
    `;
  }).join("");
}

function getSessionStatusLabel(session: RecordingSessionSummary): string {
  switch (session.phase) {
    case "recorded":
      return "Ready";
    case "uploading":
      return "Uploading";
    case "uploaded":
      return "Uploaded";
    case "failed":
      return "Failed";
    default:
      return session.phase;
  }
}

function renderSessions(sessions: RecordingSessionSummary[] | undefined): void {
  const items = Array.isArray(sessions)
    ? sessions.filter((session) => session.phase !== "uploaded")
    : [];

  if (items.length === 0) {
    sessionList.innerHTML = `<div class="session-empty">No pending capture records.</div>`;
    return;
  }

  sessionList.innerHTML = items.map((session) => {
    const canUpload = (session.phase === "recorded" || session.phase === "failed") && session.hasLocalSnapshot;
    const canReplay = session.phase === "uploaded" && Boolean(session.recordingUrl);
    const canCopy = session.phase === "uploaded" && Boolean(session.recordingUrl);
    const canOpenFolder = Boolean(session.recordingFolderId);
    const canDelete = session.phase !== "uploading";
    const showProgress = session.phase === "uploading" || session.items.length > 0;
    return `
      <div class="session-item">
        <div class="session-item-header">
          <div class="session-item-title">${escapeHtml(formatPageLabel(session.tabUrl))}</div>
          <div class="session-item-badge phase-${session.phase}">${escapeHtml(getSessionStatusLabel(session))}</div>
        </div>
        <div class="session-item-meta">
          ${escapeHtml(formatDateTime(session.stopTime || session.startTime))}<br>
          Duration: ${escapeHtml(formatTime(session.elapsedMs))}
        </div>
        ${session.error ? `<div class="session-item-error">${escapeHtml(session.error)}</div>` : ""}
        ${showProgress ? `
          <div class="session-item-progress">
            <div class="session-progress-meta">${escapeHtml(session.message || "Waiting to upload")}</div>
            <div class="session-progress-summary">${formatBytes(session.uploadedBytes)} / ${formatBytes(session.totalBytes)} (${session.progress.toFixed(1)}%)</div>
            <div class="progress-items">${renderProgressItems(session.items)}</div>
          </div>
        ` : ""}
        <div class="session-item-actions">
          ${canUpload ? renderSessionActionButton({
            action: "upload-session",
            label: "Upload",
            attrName: "data-session-id",
            attrValue: session.id,
            icon: getUploadIcon(),
          }) : ""}
          ${canReplay ? renderSessionActionButton({
            action: "open-replay",
            label: "Replay",
            attrName: "data-url",
            attrValue: session.recordingUrl || "",
            icon: getReplayIcon(),
          }) : ""}
          ${canCopy ? renderSessionActionButton({
            action: "copy-link",
            label: "Copy link",
            attrName: "data-url",
            attrValue: session.recordingUrl || "",
            icon: getCopyIcon(),
          }) : ""}
          ${canOpenFolder ? renderSessionActionButton({
            action: "open-folder",
            label: "Open folder",
            attrName: "data-folder-id",
            attrValue: session.recordingFolderId || "",
            icon: getFolderIcon(),
          }) : ""}
          ${canDelete ? renderSessionActionButton({
            action: "delete-session",
            label: "Delete",
            attrName: "data-session-id",
            attrValue: session.id,
            icon: getDeleteIcon(),
          }) : ""}
        </div>
      </div>
    `;
  }).join("");
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

function updateFolderHint(settings: UploadSettings | null): void {
  if (!settings || !settings.folderId) {
    googleDriveFolderHint.textContent = "Using your Google Drive root folder.";
    return;
  }
  googleDriveFolderHint.textContent = `Resolved folder ID: ${settings.folderId}`;
}

function renderUploadHistory(history: UploadHistoryEntry[] | undefined): void {
  const items = Array.isArray(history) ? history : [];
  const { visibleItems, hiddenCount } = getVisibleUploadHistory(items);
  uploadHistoryList.innerHTML = renderUploadHistoryList(visibleItems);
  uploadHistoryMoreBtn.classList.toggle("hidden", hiddenCount === 0);
}

function updateRecordingUI(recording: RecordingStatus | null): void {
  if (recording?.isRecording) {
    toggleBtn.textContent = "Stop Recording";
    toggleBtn.className = "btn btn-stop";
    pauseResumeBtn.classList.remove("hidden");
    pauseResumeBtn.textContent = recording.isPaused ? "Resume Recording" : "Pause Recording";
    statusBar.classList.remove("hidden");
    stats.classList.remove("hidden");
    consoleCount.textContent = String(recording.consoleLogCount || 0);
    networkCount.textContent = String(recording.networkRequestCount || 0);

    if (recording.isPaused) {
      stopRecordingTimer();
      timerEl.textContent = formatTime(recording.elapsedMs || 0);
    } else if (!timerInterval) {
      startRecordingTimer(recording.elapsedMs || 0);
    }
    return;
  }

  toggleBtn.textContent = "Start Recording";
  toggleBtn.className = "btn btn-start";
  pauseResumeBtn.classList.add("hidden");
  statusBar.classList.add("hidden");
  stats.classList.add("hidden");
  stopRecordingTimer();
}

function handleStateUpdate(state: PopupState): void {
  updateRecordingUI(state.recording);
  renderSessions(state.sessions);
  updateGoogleDriveUI(state.googleDrive.isConnected);
  if (!isEditingFolder) {
    googleDriveFolderInput.value = getFolderDisplayValue(state.settings.folderInput);
    setFolderEditingState(false);
  }
  updateFolderHint(state.settings);
  renderUploadHistory(state.uploadHistory);
}

async function refreshGoogleDriveStatus(): Promise<void> {
  try {
    const result = await chrome.runtime.sendMessage({ action: "GOOGLE_DRIVE_STATUS" }) as MessageResponse & { isConnected?: boolean };
    if (result.ok) {
      updateGoogleDriveUI(Boolean(result.isConnected));
    }
  } catch {
    // Ignore warmup failures.
  }
}

function openExternalUrl(url: string): void {
  chrome.tabs.create({ url });
}

toggleBtn.addEventListener("click", async () => {
  toggleBtn.disabled = true;
  errorMsg.classList.add("hidden");

  try {
    const currentState = await loadStateFromStorage();
    const isRecording = currentState?.recording?.isRecording ?? false;

    if (isRecording) {
      const result = await chrome.runtime.sendMessage({ action: "STOP_RECORDING" }) as MessageResponse;
      if (!result.ok) {
        showError(result.error || "Failed to stop recording");
      }
    } else {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const result = await chrome.runtime.sendMessage({ action: "START_RECORDING", tabId: tab.id }) as MessageResponse;
      if (!result.ok) {
        showError(result.error || "Failed to start recording");
      }
    }
  } catch (error) {
    showError((error as Error).message);
  } finally {
    toggleBtn.disabled = false;
  }
});

pauseResumeBtn.addEventListener("click", async () => {
  pauseResumeBtn.disabled = true;
  errorMsg.classList.add("hidden");

  try {
    const currentState = await loadStateFromStorage();
    const isPaused = currentState?.recording?.isPaused ?? false;
    const result = await chrome.runtime.sendMessage({
      action: isPaused ? "RESUME_RECORDING" : "PAUSE_RECORDING",
    }) as MessageResponse;
    if (!result.ok) {
      showError(result.error || "Recording control failed");
    }
  } catch (error) {
    showError((error as Error).message);
  } finally {
    pauseResumeBtn.disabled = false;
  }
});

reloadBtn.addEventListener("click", () => {
  window.location.reload();
});

googleDriveConnectBtn.addEventListener("click", () => {
  chrome.tabs.create({
    url: chrome.runtime.getURL("drive-auth/drive-auth.html"),
  });
  window.close();
});

googleDriveDisconnectBtn.addEventListener("click", async () => {
  googleDriveDisconnectBtn.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ action: "GOOGLE_DRIVE_DISCONNECT" }) as MessageResponse;
    if (!result.ok) {
      showError(result.error || "Disconnect failed");
    }
  } catch (error) {
    showError((error as Error).message);
  } finally {
    googleDriveDisconnectBtn.disabled = false;
  }
});

saveFolderBtn.addEventListener("click", async () => {
  if (!isEditingFolder) {
    setFolderEditingState(true);
    return;
  }

  saveFolderBtn.disabled = true;
  errorMsg.classList.add("hidden");

  try {
    const result = await chrome.runtime.sendMessage({
      action: "UPDATE_SETTINGS",
      data: {
        folderInput: getFolderSaveValue(googleDriveFolderInput.value),
      },
    }) as MessageResponse & { settings?: UploadSettings };

    if (!result.ok) {
      showError(result.error || "Failed to save upload folder");
      return;
    }

    if (result.settings) {
      googleDriveFolderInput.value = getFolderDisplayValue(result.settings.folderInput);
      updateFolderHint(result.settings);
      setFolderEditingState(false);
      showToast("Upload folder saved.");
    }
  } catch (error) {
    showError((error as Error).message);
  } finally {
    saveFolderBtn.disabled = false;
  }
});

sessionList.addEventListener("click", async (event) => {
  const target = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>("[data-action]");
  if (!target) {
    return;
  }

  const action = target.getAttribute("data-action");
  if (action === "open-replay") {
    const url = target.getAttribute("data-url");
    if (url) {
      openExternalUrl(url);
    }
    return;
  }

  if (action === "copy-link") {
    const url = target.getAttribute("data-url");
    if (!url) {
      return;
    }
    target.disabled = true;
    try {
      await navigator.clipboard.writeText(url);
      showSuccess("Replay link copied.");
    } catch (error) {
      showError((error as Error).message || "Failed to copy replay link");
    } finally {
      target.disabled = false;
    }
    return;
  }

  if (action === "open-folder") {
    const folderId = target.getAttribute("data-folder-id");
    if (folderId) {
      openExternalUrl(`https://drive.google.com/drive/folders/${folderId}`);
    }
    return;
  }

  if (action === "upload-session") {
    const sessionId = target.getAttribute("data-session-id");
    if (!sessionId) {
      return;
    }
    const button = target as HTMLButtonElement;
    button.disabled = true;
    try {
      const result = await chrome.runtime.sendMessage({
        action: "UPLOAD_TO_GOOGLE_DRIVE",
        data: { sessionId },
      }) as MessageResponse;
      if (!result.ok) {
        showError(result.error || "Failed to upload session");
        button.disabled = false;
      }
    } catch (error) {
      showError((error as Error).message);
      button.disabled = false;
    }
    return;
  }

  if (action === "delete-session") {
    const sessionId = target.getAttribute("data-session-id");
    if (!sessionId) {
      return;
    }
    target.disabled = true;
    try {
      const result = await chrome.runtime.sendMessage({
        action: "DELETE_SESSION",
        data: { sessionId },
      }) as MessageResponse;
      if (!result.ok) {
        showError(result.error || "Failed to delete session");
        target.disabled = false;
      }
    } catch (error) {
      showError((error as Error).message);
      target.disabled = false;
    }
  }
});

uploadHistoryList.addEventListener("click", async (event) => {
  await handleUploadHistoryAction(event.target as HTMLElement | null, {
    openExternalUrl,
    copyLink: async (url, button) => {
      button.disabled = true;
      try {
        await navigator.clipboard.writeText(url);
        showToast("Replay link copied.");
      } catch (error) {
        showError((error as Error).message || "Failed to copy replay link");
      } finally {
        button.disabled = false;
      }
    },
    deleteHistoryEntry: async (historyEntryId, button) => {
      button.disabled = true;
      try {
        const result = await chrome.runtime.sendMessage({
          action: "DELETE_UPLOAD_HISTORY_ENTRY",
          data: { historyEntryId },
        }) as MessageResponse;
        if (!result.ok) {
          showError(result.error || "Failed to delete history item");
          button.disabled = false;
        }
      } catch (error) {
        showError((error as Error).message);
        button.disabled = false;
      }
    },
  });
});

uploadHistoryMoreBtn.addEventListener("click", () => {
  chrome.tabs.create({
    url: chrome.runtime.getURL(HISTORY_PAGE_PATH),
  });
});

async function initPopup(): Promise<void> {
  const initialState = await loadStateFromStorage();
  if (initialState) {
    handleStateUpdate(initialState);
  } else {
    renderSessions([]);
    renderUploadHistory([]);
  }

  try {
    const settingsResult = await chrome.runtime.sendMessage({ action: "GET_SETTINGS" }) as MessageResponse & {
      settings?: UploadSettings;
      uploadHistory?: UploadHistoryEntry[];
    };
    if (settingsResult.ok && settingsResult.settings) {
      googleDriveFolderInput.value = getFolderDisplayValue(settingsResult.settings.folderInput);
      setFolderEditingState(false);
      updateFolderHint(settingsResult.settings);
      if (settingsResult.uploadHistory) {
        renderUploadHistory(settingsResult.uploadHistory);
      }
    }
  } catch {
    // Ignore worker warmup errors.
  }

  await refreshGoogleDriveStatus();

  const unsubscribe = subscribeToStateChanges((state) => {
    handleStateUpdate(state);
  });

  window.addEventListener("unload", () => {
    stopRecordingTimer();
    unsubscribe();
  });
}

githubLinkBtn.addEventListener("click", () => {
  openExternalUrl(GITHUB_REPO_URL);
});

contributeLinkBtn.addEventListener("click", () => {
  openExternalUrl(GITHUB_ISSUES_URL);
});

void initPopup();
