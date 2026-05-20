/**
 * Drives the extension popup UI and service-worker message interactions.
 */
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
  sortUploadHistoryNewestFirst,
} from "../shared/upload-history-ui";

/**
 * Popup UI controller.
 *
 * The popup is disposable browser UI: it renders the latest persisted service
 * worker state, sends user commands back to the worker, and keeps transient DOM
 * details such as timers/toasts local. Durable recording truth must stay in the
 * service worker because this window can close at any time.
 */
const GITHUB_REPO_URL = "https://github.com/gnasdev/gn-tracing";
const GITHUB_ISSUES_URL = `${GITHUB_REPO_URL}/issues`;
const SERVICE_STATE_KEY = "gn_tracing_state";
const RELOAD_TOAST_KEY = "gn_tracing_reload_toast";

const recordingActions = document.getElementById("recording-actions")!;
const toggleBtn = document.getElementById("toggle-btn") as HTMLButtonElement;
const removeRecordingBtn = document.getElementById("remove-recording-btn") as HTMLButtonElement;
const reloadBtn = document.getElementById("reload-btn") as HTMLButtonElement;
const checkUpdateBtn = document.getElementById("check-update-btn") as HTMLButtonElement;
const settingsPanel = document.getElementById("settings-panel") as HTMLDetailsElement;
const mainGoogleDriveSlot = document.getElementById("main-google-drive-slot")!;
const settingsGoogleDriveSlot = document.getElementById("settings-google-drive-slot")!;
const statusBar = document.getElementById("status-bar")!;
const timerEl = document.getElementById("timer")!;
const stats = document.getElementById("stats")!;
const consoleCount = document.getElementById("console-count")!;
const networkCount = document.getElementById("network-count")!;
const sessionQueueSection = document.getElementById("session-queue-section")!;
const sessionList = document.getElementById("session-list")!;
const errorMsg = document.getElementById("error-msg")!;
const toastEl = document.getElementById("toast")!;
const toastMessageEl = document.getElementById("toast-message")!;
const toastCloseBtn = document.getElementById("toast-close-btn") as HTMLButtonElement;

const googleDriveSection = document.getElementById("google-drive-section")!;
const googleDriveStatus = document.getElementById("google-drive-status")!;
const googleDriveConnectBtn = document.getElementById("google-drive-connect-btn") as HTMLButtonElement;
const googleDriveDisconnectBtn = document.getElementById("google-drive-disconnect-btn") as HTMLButtonElement;
const googleDriveFolderInput = document.getElementById("google-drive-folder-input") as HTMLInputElement;
const googleDriveFolderHint = document.getElementById("google-drive-folder-hint")!;
const saveFolderBtn = document.getElementById("save-folder-btn") as HTMLButtonElement;
const captureRequestBodiesInput = document.getElementById("capture-request-bodies-input") as HTMLInputElement;
const captureResponseBodiesInput = document.getElementById("capture-response-bodies-input") as HTMLInputElement;
const captureWebSocketFramesInput = document.getElementById("capture-websocket-frames-input") as HTMLInputElement;
const popupUploadHistoryList = document.getElementById("popup-upload-history-list")!;
const uploadHistoryPageBtn = document.getElementById("upload-history-page-btn") as HTMLButtonElement;

const githubLinkBtn = document.getElementById("github-link-btn") as HTMLButtonElement;
const contributeLinkBtn = document.getElementById("contribute-link-btn") as HTMLButtonElement;

let timerInterval: ReturnType<typeof setInterval> | null = null;
let timerRecording: RecordingStatus | null = null;
let toastTimeout: ReturnType<typeof setTimeout> | null = null;
let isEditingFolder = false;
let currentUploadHistory: UploadHistoryEntry[] = [];
const pendingDeletedHistoryIds = new Set<string>();
let currentSettings: UploadSettings | null = null;
let activeUpdateCheckRequestId: string | null = null;

function closeSettingsSection(): void {
  if (settingsPanel.open) {
    settingsPanel.open = false;
  }
  if (isEditingFolder) {
    googleDriveFolderInput.value = getFolderDisplayValue(currentSettings?.folderInput);
    setFolderEditingState(false);
  }
}

function getEditIcon(): string {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3Z"/>
      <path d="m14 7 3 3"/>
    </svg>
  `;
}

function getSaveIcon(): string {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M5 5h11l3 3v11H5V5Z"/>
      <path d="M8 5v5h7"/>
      <path d="M8 15h8"/>
      <path d="M8 18h5"/>
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

function getLiveRecordingElapsedMs(recording: RecordingStatus, now = Date.now()): number {
  const elapsedMs = Number.isFinite(recording.elapsedMs) ? recording.elapsedMs : 0;

  if (!recording.isRecording) {
    return Math.max(0, elapsedMs);
  }

  if (recording.startTime) {
    return Math.max(0, now - recording.startTime);
  }

  if (Number.isFinite(recording.elapsedUpdatedAt)) {
    return Math.max(0, elapsedMs + Math.max(0, now - recording.elapsedUpdatedAt));
  }

  return Math.max(0, elapsedMs);
}

function updateTimerDisplay(): void {
  if (!timerRecording) {
    return;
  }
  timerEl.textContent = formatTime(getLiveRecordingElapsedMs(timerRecording));
}

function startRecordingTimer(recording: RecordingStatus): void {
  if (timerInterval) {
    clearInterval(timerInterval);
  }
  timerRecording = recording;
  updateTimerDisplay();
  timerInterval = setInterval(updateTimerDisplay, 1000);
}

function stopRecordingTimer(): void {
  timerRecording = null;
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

function showToast(message: string, durationMs = 1800): void {
  toastMessageEl.textContent = message;
  toastEl.classList.remove("hidden");
  if (toastTimeout) {
    clearTimeout(toastTimeout);
  }
  toastTimeout = setTimeout(() => {
    hideToast();
  }, durationMs);
}

function hideToast(): void {
  toastEl.classList.add("hidden");
  if (toastTimeout) {
    clearTimeout(toastTimeout);
    toastTimeout = null;
  }
}

function setUpdateCheckLoading(isLoading: boolean): void {
  checkUpdateBtn.classList.toggle("is-loading", isLoading);
  checkUpdateBtn.disabled = isLoading;
  checkUpdateBtn.setAttribute("aria-busy", String(isLoading));
}

function finishManualUpdateCheck(): void {
  activeUpdateCheckRequestId = null;
  setUpdateCheckLoading(false);
}

function checkForUpdate(options: { notifyAlways?: boolean } = {}): void {
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const notifyAlways = Boolean(options.notifyAlways);
  if (options.notifyAlways) {
    activeUpdateCheckRequestId = requestId;
    setUpdateCheckLoading(true);
  }

  // Keep update checks on the request/response channel so MV3 does not drop a
  // fire-and-forget fetch when the service worker becomes idle.
  void chrome.runtime.sendMessage({
    action: "CHECK_FOR_UPDATE",
  }).then((result: MessageResponse) => {
    handleUpdateCheckResult(result, requestId, notifyAlways);
  }).catch((error: Error) => {
    if (activeUpdateCheckRequestId === requestId) {
      finishManualUpdateCheck();
    }
    if (notifyAlways) {
      showToast(error.message || "Failed to check for updates.");
    }
  });
}

function handleUpdateCheckResult(result: MessageResponse, requestId: string, notifyAlways: boolean): void {
  if (activeUpdateCheckRequestId === requestId) {
    finishManualUpdateCheck();
  }

  if (!result.ok) {
    if (notifyAlways) {
      showToast(result.error || "Failed to check for updates.");
    }
    return;
  }

  if (result.update?.isUpdateAvailable || notifyAlways) {
    showToast(result.message || "Update check complete.");
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
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 16V4"/>
      <path d="m7 9 5-5 5 5"/>
      <path d="M5 18h14"/>
      <path d="M7 21h10"/>
    </svg>
  `;
}

function getReplayIcon(): string {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="9"/>
      <path d="m10 8 6 4-6 4V8Z" fill="currentColor" stroke="none"/>
    </svg>
  `;
}

function getFolderIcon(): string {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 7h7l2 2h9v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>
      <path d="M3 7V5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v2"/>
    </svg>
  `;
}

function getCopyIcon(): string {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="9" y="7" width="11" height="13" rx="2"/>
      <path d="M5 15H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1"/>
    </svg>
  `;
}

function getDeleteIcon(): string {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4 7h16"/>
      <path d="M10 11v6"/>
      <path d="M14 11v6"/>
      <path d="M6 7l1 14h10l1-14"/>
      <path d="M9 7V4h6v3"/>
    </svg>
  `;
}

function renderProgressItems(
  items: ProgressItemSnapshot[] | undefined,
  fallbackProgress = 0,
): string {
  const safeItems = Array.isArray(items) ? items : [];
  const totalBytes = safeItems.reduce((sum, item) => sum + Math.max(0, item.totalBytes || 0), 0);
  const loadedBytes = safeItems.reduce((sum, item) => {
    const total = Math.max(0, item.totalBytes || 0);
    const loaded = Math.max(0, item.loadedBytes || 0);
    return sum + (total > 0 ? Math.min(loaded, total) : loaded);
  }, 0);
  const percent = totalBytes > 0
    ? Math.max(0, Math.min(100, (loadedBytes / totalBytes) * 100))
    : Math.max(0, Math.min(100, fallbackProgress || 0));
  const hasFailed = safeItems.some((item) => item.status === "failed");
  const allFinished = safeItems.length > 0 && safeItems.every((item) => item.status === "uploaded" || item.status === "skipped");
  const statusClass = hasFailed ? "is-failed" : allFinished ? "is-success" : "is-active";
  const fillPercent = hasFailed || allFinished ? 100 : percent;

  return `
    <div
      class="progress-item ${statusClass}"
      style="--item-progress:${fillPercent}%;"
      aria-label="Progress ${percent.toFixed(1)}%"
    ></div>
  `;
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
            <div class="progress-items">${renderProgressItems(session.items, session.progress)}</div>
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

function renderPopupUploadHistory(history: UploadHistoryEntry[] | undefined): void {
  const sortedHistory = sortUploadHistoryNewestFirst(history);
  for (const historyEntryId of Array.from(pendingDeletedHistoryIds)) {
    if (!sortedHistory.some((entry) => entry.id === historyEntryId)) {
      pendingDeletedHistoryIds.delete(historyEntryId);
    }
  }
  currentUploadHistory = sortedHistory.filter((entry) => !pendingDeletedHistoryIds.has(entry.id));
  const { visibleItems, hiddenCount } = getVisibleUploadHistory(currentUploadHistory);
  popupUploadHistoryList.innerHTML = [
    renderUploadHistoryList(visibleItems),
    hiddenCount > 0 ? `<div class="history-empty">${hiddenCount} older upload${hiddenCount === 1 ? "" : "s"} hidden.</div>` : "",
  ].join("");
}

function updateGoogleDriveUI(isConnected: boolean): void {
  const targetSlot = isConnected ? settingsGoogleDriveSlot : mainGoogleDriveSlot;
  if (googleDriveSection.parentElement !== targetSlot) {
    targetSlot.appendChild(googleDriveSection);
  }

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

function setCaptureUiVisibility(isVisible: boolean): void {
  recordingActions.classList.toggle("hidden", !isVisible);
  sessionQueueSection.classList.toggle("hidden", !isVisible);

  if (isVisible) {
    return;
  }

  removeRecordingBtn.classList.add("hidden");
  statusBar.classList.add("hidden");
  stats.classList.add("hidden");
  sessionList.innerHTML = "";
  stopRecordingTimer();
}

function updateFolderHint(settings: UploadSettings | null): void {
  if (!settings || !settings.folderId) {
    googleDriveFolderHint.textContent = "Using your Google Drive root folder.";
    return;
  }
  googleDriveFolderHint.textContent = `Resolved folder ID: ${settings.folderId}`;
}

function updateCapturePrivacyUI(settings: UploadSettings | null): void {
  currentSettings = settings;
  captureRequestBodiesInput.checked = Boolean(settings?.captureRequestBodies);
  captureResponseBodiesInput.checked = Boolean(settings?.captureResponseBodies);
  captureWebSocketFramesInput.checked = Boolean(settings?.captureWebSocketFrames);
}

function getStartRecordingIcon(): string {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="7"/>
      <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>
    </svg>
  `;
}

function getStopRecordingIcon(): string {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M7 7h10v10H7z"/>
      <path d="M17 12h2.5A2.5 2.5 0 0 1 22 14.5V17"/>
      <path d="m19 15 3 2-3 2"/>
    </svg>
  `;
}

function setButtonLabel(button: HTMLButtonElement, icon: string, label: string): void {
  button.innerHTML = `${icon}<span>${escapeHtml(label)}</span>`;
}

function updateRecordingUI(recording: RecordingStatus | null): void {
  if (recording?.isRecording) {
    setButtonLabel(toggleBtn, getStopRecordingIcon(), "Stop & Upload");
    toggleBtn.className = "btn btn-stop";
    recordingActions.classList.add("is-recording");
    removeRecordingBtn.classList.remove("hidden");
    statusBar.classList.remove("hidden");
    stats.classList.remove("hidden");
    consoleCount.textContent = String(recording.consoleLogCount || 0);
    networkCount.textContent = String(recording.networkRequestCount || 0);

    if (timerInterval) {
      timerRecording = recording;
      updateTimerDisplay();
    } else {
      startRecordingTimer(recording);
    }
    return;
  }

  setButtonLabel(toggleBtn, getStartRecordingIcon(), "Start Recording");
  toggleBtn.className = "btn btn-start";
  recordingActions.classList.remove("is-recording");
  removeRecordingBtn.classList.add("hidden");
  statusBar.classList.add("hidden");
  stats.classList.add("hidden");
  stopRecordingTimer();
}

function handleStateUpdate(state: PopupState): void {
  const isGoogleDriveConnected = state.googleDrive.isConnected;
  updateGoogleDriveUI(isGoogleDriveConnected);
  setCaptureUiVisibility(isGoogleDriveConnected);

  if (isGoogleDriveConnected) {
    updateRecordingUI(state.recording);
    renderSessions(state.sessions);
  }

  renderPopupUploadHistory(state.uploadHistory);
  if (!isEditingFolder) {
    googleDriveFolderInput.value = getFolderDisplayValue(state.settings.folderInput);
    setFolderEditingState(false);
  }
  updateFolderHint(state.settings);
  updateCapturePrivacyUI(state.settings);
}

async function refreshPopupFromStorage(): Promise<void> {
  const state = await loadStateFromStorage();
  if (state) {
    handleStateUpdate(state);
  }
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
    if (!currentState?.googleDrive.isConnected) {
      showError("Connect Google Drive before recording.");
      return;
    }

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

removeRecordingBtn.addEventListener("click", async () => {
  removeRecordingBtn.disabled = true;
  errorMsg.classList.add("hidden");

  try {
    const result = await chrome.runtime.sendMessage({ action: "REMOVE_RECORDING" }) as MessageResponse;
    if (!result.ok) {
      showError(result.error || "Failed to remove recording");
      return;
    }
    showToast("Recording removed.");
  } catch (error) {
    showError((error as Error).message);
  } finally {
    removeRecordingBtn.disabled = false;
  }
});

reloadBtn.addEventListener("click", () => {
  window.sessionStorage.setItem(RELOAD_TOAST_KEY, "1");
  window.location.reload();
});

toastCloseBtn.addEventListener("click", () => {
  hideToast();
});

checkUpdateBtn.addEventListener("click", () => {
  checkForUpdate({ notifyAlways: true });
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

async function saveCapturePrivacySettings(): Promise<void> {
  const previousSettings = currentSettings;
  const inputs = [
    captureRequestBodiesInput,
    captureResponseBodiesInput,
    captureWebSocketFramesInput,
  ];
  inputs.forEach((input) => {
    input.disabled = true;
  });
  errorMsg.classList.add("hidden");

  try {
    const result = await chrome.runtime.sendMessage({
      action: "UPDATE_SETTINGS",
      data: {
        captureRequestBodies: captureRequestBodiesInput.checked,
        captureResponseBodies: captureResponseBodiesInput.checked,
        captureWebSocketFrames: captureWebSocketFramesInput.checked,
      },
    }) as MessageResponse & { settings?: UploadSettings };

    if (!result.ok) {
      updateCapturePrivacyUI(previousSettings);
      showError(result.error || "Failed to save capture privacy settings");
      return;
    }

    if (result.settings) {
      updateCapturePrivacyUI(result.settings);
      showToast("Capture privacy saved.");
    }
  } catch (error) {
    updateCapturePrivacyUI(previousSettings);
    showError((error as Error).message);
  } finally {
    inputs.forEach((input) => {
      input.disabled = false;
    });
  }
}

captureRequestBodiesInput.addEventListener("change", () => {
  void saveCapturePrivacySettings();
});

captureResponseBodiesInput.addEventListener("change", () => {
  void saveCapturePrivacySettings();
});

captureWebSocketFramesInput.addEventListener("change", () => {
  void saveCapturePrivacySettings();
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

settingsPanel.addEventListener("toggle", () => {
  if (settingsPanel.open) {
    updateCapturePrivacyUI(currentSettings);
  } else if (isEditingFolder) {
    googleDriveFolderInput.value = getFolderDisplayValue(currentSettings?.folderInput);
    setFolderEditingState(false);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeSettingsSection();
    hideToast();
  }
});

popupUploadHistoryList.addEventListener("click", async (event) => {
  const handled = await handleUploadHistoryAction(event.target as HTMLElement | null, {
    openExternalUrl,
    copyLink: async (url, button) => {
      button.disabled = true;
      try {
        await navigator.clipboard.writeText(url);
        showSuccess("Replay link copied.");
      } catch (error) {
        showError((error as Error).message || "Failed to copy replay link");
      } finally {
        button.disabled = false;
      }
    },
    deleteHistoryEntry: async (historyEntryId, button) => {
      const previousHistory = currentUploadHistory;
      pendingDeletedHistoryIds.add(historyEntryId);
      renderPopupUploadHistory(previousHistory);
      button.disabled = true;
      try {
        const result = await chrome.runtime.sendMessage({
          action: "DELETE_UPLOAD_HISTORY_ENTRY",
          data: { historyEntryId },
        }) as MessageResponse & { state?: PopupState; uploadHistory?: UploadHistoryEntry[] };

        if (!result.ok) {
          pendingDeletedHistoryIds.delete(historyEntryId);
          renderPopupUploadHistory(previousHistory);
          showError(result.error || "Failed to delete history item");
          return;
        }

        if (result.state) {
          handleStateUpdate(result.state);
        } else {
          renderPopupUploadHistory(
            Array.isArray(result.uploadHistory)
              ? result.uploadHistory
              : currentUploadHistory.filter((entry) => entry.id !== historyEntryId),
          );
          void refreshPopupFromStorage();
        }
      } catch (error) {
        pendingDeletedHistoryIds.delete(historyEntryId);
        renderPopupUploadHistory(previousHistory);
        showError((error as Error).message);
      }
    },
  });

  if (!handled) {
    errorMsg.classList.add("hidden");
  }
});

uploadHistoryPageBtn.addEventListener("click", () => {
  chrome.tabs.create({
    url: chrome.runtime.getURL(HISTORY_PAGE_PATH),
  });
});

chrome.runtime.onMessage.addListener((message: {
  action?: string;
  state?: PopupState;
}) => {
  if (message.action !== "POPUP_STATE_UPDATED" || !message.state) {
    return false;
  }

  handleStateUpdate(message.state);
  return false;
});

async function initPopup(): Promise<void> {
  if (window.sessionStorage.getItem(RELOAD_TOAST_KEY)) {
    window.sessionStorage.removeItem(RELOAD_TOAST_KEY);
    showToast("Popup reloaded.");
  }

  const initialState = await loadStateFromStorage();
  if (initialState) {
    handleStateUpdate(initialState);
  } else {
    renderSessions([]);
    renderPopupUploadHistory([]);
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
      updateCapturePrivacyUI(settingsResult.settings);
    }
    if (settingsResult.ok && Array.isArray(settingsResult.uploadHistory)) {
      renderPopupUploadHistory(settingsResult.uploadHistory);
    }
  } catch {
    // Ignore worker warmup errors.
  }

  await refreshGoogleDriveStatus();
  checkForUpdate();

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
