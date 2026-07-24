/**
 * Drives the extension popup UI and service-worker message interactions.
 */

import { DEFAULT_DRAW_COLOR, DRAW_COLOR_PRESETS, normalizeDrawColor } from "../shared/drawing";
import { resolveReplayOpenUrl } from "../shared/player-host";
import { getRecordingTabTarget } from "../shared/recording-target";
import { buildCloudRemoteOpenUrl, resolveHistoryProvider } from "../shared/storage-provider";
import { attachThemeToggle } from "../shared/theme";
import {
  escapeHtml,
  formatDateTime,
  formatPageLabel,
  formatTime,
  getVisibleUploadHistory,
  HISTORY_PAGE_PATH,
  handleUploadHistoryAction,
  renderUploadHistoryList,
  sortUploadHistoryNewestFirst,
} from "../shared/upload-history-ui";
import type {
  MessageResponse,
  PopupState,
  ProgressItemSnapshot,
  RecordingSessionSummary,
  RecordingStatus,
  UploadHistoryEntry,
} from "../types/messages";

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
const MIRRORED_DRIVE_CONNECTED_KEY = "gn_tracing_google_drive_connected";
const MIRRORED_DROPBOX_CONNECTED_KEY = "gn_tracing_dropbox_connected";
const UPLOAD_SETTINGS_KEY = "gn_tracing_upload_settings";

const recordingActions = document.getElementById("recording-actions")!;
const toggleBtn = document.getElementById("toggle-btn") as HTMLButtonElement;
const removeRecordingBtn = document.getElementById("remove-recording-btn") as HTMLButtonElement;
const drawToggleBtn = document.getElementById("draw-toggle-btn") as HTMLButtonElement;
const drawingSection = document.getElementById("drawing-section")!;
const drawColorSwatches = document.getElementById("draw-color-swatches")!;
const drawColorInput = document.getElementById("draw-color-input") as HTMLInputElement;
const recordingUnavailableMsg = document.getElementById("recording-unavailable-msg")!;
const settingsPageBtn = document.getElementById("settings-page-btn") as HTMLButtonElement;
const mainGoogleDriveSlot = document.getElementById("main-google-drive-slot")!;
const connectedGoogleDriveSlot = document.getElementById("connected-google-drive-slot")!;
const statusBar = document.getElementById("status-bar")!;
const timerEl = document.getElementById("timer")!;
const stats = document.getElementById("stats")!;
const consoleCount = document.getElementById("console-count")!;
const networkCount = document.getElementById("network-count")!;
const sessionQueueSection = document.getElementById("session-queue-section")!;
const sessionList = document.getElementById("session-list")!;
const errorMsg = document.getElementById("error-msg")!;
const toastEl = document.getElementById("toast")!;
const toastIconEl = document.getElementById("toast-icon")!;
const toastMessageEl = document.getElementById("toast-message")!;
const toastLinkEl = document.getElementById("toast-link") as HTMLAnchorElement;
const toastCloseBtn = document.getElementById("toast-close-btn") as HTMLButtonElement;

const googleDriveSection = document.getElementById("google-drive-section")!;
const googleDriveStatus = document.getElementById("google-drive-status")!;
const storageProviderLabel = document.getElementById("storage-provider-label");
const storageProviderSelect = document.getElementById(
  "storage-provider-select",
) as HTMLSelectElement | null;
const manageStorageBtn = document.getElementById("manage-storage-btn") as HTMLButtonElement | null;
const storageConnectHint = document.getElementById("storage-connect-hint");

/** Connected flags for all providers — popup only lists these in the select. */
const connectedProviders = new Map<string, boolean>([
  ["google-drive", false],
  ["dropbox", false],
]);
const popupUploadHistoryList = document.getElementById("popup-upload-history-list")!;
const uploadHistoryPageBtn = document.getElementById(
  "upload-history-page-btn",
) as HTMLButtonElement;

const githubLinkBtn = document.getElementById("github-link-btn") as HTMLButtonElement;
const contributeLinkBtn = document.getElementById("contribute-link-btn") as HTMLButtonElement;

let timerInterval: ReturnType<typeof setInterval> | null = null;
let timerRecording: RecordingStatus | null = null;
let toastTimeout: ReturnType<typeof setTimeout> | null = null;
let currentUploadHistory: UploadHistoryEntry[] = [];
const pendingDeletedHistoryIds = new Set<string>();
const animatingUploadHistoryIds = new Set<string>();
const uploadHistoryAnimationTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
let isUploadHistoryAnimationReady = false;
let latestPopupState: PopupState | null = null;
let activeTabRecordingError: string | null = "Checking whether this tab can be recorded.";
let toggleActionInFlight = false;
let toggleActionMode: "start" | "stop" | null = null;
let activeTabRecordingCheckId = 0;
let selectedDrawColor = DEFAULT_DRAW_COLOR;
let drawColorUpdateInFlight = false;

type ToastVariant = "success" | "info" | "error";

const SESSION_PROGRESS_FIELDS: Array<keyof RecordingSessionSummary> = [
  "progress",
  "uploadedBytes",
  "totalBytes",
  "message",
  "items",
];

async function loadStateFromStorage(): Promise<PopupState | null> {
  try {
    const result = await chrome.storage.session.get(SERVICE_STATE_KEY);
    return result[SERVICE_STATE_KEY] || null;
  } catch {
    return null;
  }
}

/**
 * Reads the connection mirror for the **active** storage provider from
 * `chrome.storage.local`. Survives browser restarts (unlike session state) so
 * the popup can paint the correct auth UI before the service worker re-hydrates.
 * Each provider uses its own mirror key (Drive / Dropbox).
 */
async function loadMirroredStorageConnected(): Promise<{
  provider: string;
  isConnected: boolean | null;
}> {
  try {
    const settingsResult = await chrome.storage.local.get(UPLOAD_SETTINGS_KEY);
    const stored = settingsResult[UPLOAD_SETTINGS_KEY] as
      | { activeStorageProvider?: string }
      | undefined;
    const provider =
      stored?.activeStorageProvider === "dropbox" ||
      stored?.activeStorageProvider === "google-drive"
        ? stored.activeStorageProvider
        : "google-drive";
    const key =
      provider === "dropbox" ? MIRRORED_DROPBOX_CONNECTED_KEY : MIRRORED_DRIVE_CONNECTED_KEY;
    const result = await chrome.storage.local.get(key);
    const value = result[key];
    return {
      provider,
      isConnected: typeof value === "boolean" ? value : null,
    };
  } catch {
    return { provider: "google-drive", isConnected: null };
  }
}

/** @deprecated Prefer loadMirroredStorageConnected */
async function loadMirroredDriveConnected(): Promise<boolean | null> {
  const mirrored = await loadMirroredStorageConnected();
  return mirrored.isConnected;
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
  showToast(message, 1800, { variant: "success" });
}

function normalizeToastMessage(message: string): string {
  return message.trim().replace(/\.+$/, "");
}

function getToastIcon(variant: ToastVariant): string {
  switch (variant) {
    case "info":
      return "i";
    case "error":
      return "!";
    default:
      return "✓";
  }
}

function showToast(
  message: string,
  durationMs = 1800,
  options: { variant?: ToastVariant; linkUrl?: string; linkLabel?: string } = {},
): void {
  const variant = options.variant || "success";
  toastIconEl.textContent = getToastIcon(variant);
  toastMessageEl.textContent = normalizeToastMessage(message);
  toastEl.classList.remove("toast-success", "toast-info", "toast-error");
  toastEl.classList.add(`toast-${variant}`);
  toastEl.setAttribute("role", variant === "error" ? "alert" : "status");
  toastEl.setAttribute("aria-live", variant === "error" ? "assertive" : "polite");
  if (options.linkUrl) {
    toastLinkEl.href = options.linkUrl;
    toastLinkEl.textContent = options.linkLabel || "Open";
    toastLinkEl.classList.remove("hidden");
  } else {
    toastLinkEl.removeAttribute("href");
    toastLinkEl.textContent = "";
    toastLinkEl.classList.add("hidden");
  }
  toastEl.classList.remove("hidden");
  if (toastTimeout) {
    clearTimeout(toastTimeout);
  }
  if (durationMs > 0) {
    toastTimeout = setTimeout(() => {
      hideToast();
    }, durationMs);
  }
}

function hideToast(): void {
  toastEl.classList.add("hidden");
  if (toastTimeout) {
    clearTimeout(toastTimeout);
    toastTimeout = null;
  }
}

function renderSessionActionButton(params: {
  action: string;
  label: string;
  icon: string;
  attrName: string;
  attrValue: string;
  extraAttrs?: Record<string, string>;
}): string {
  const extras = params.extraAttrs
    ? Object.entries(params.extraAttrs)
        .map(([key, value]) => `${key}="${escapeHtml(value)}"`)
        .join(" ")
    : "";
  return `
    <button
      type="button"
      class="session-icon-button"
      data-action="${params.action}"
      ${params.attrName}="${escapeHtml(params.attrValue)}"
      ${extras}
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
  const percent =
    totalBytes > 0
      ? Math.max(0, Math.min(100, (loadedBytes / totalBytes) * 100))
      : Math.max(0, Math.min(100, fallbackProgress || 0));
  const hasFailed = safeItems.some((item) => item.status === "failed");
  const allFinished =
    safeItems.length > 0 &&
    safeItems.every((item) => item.status === "uploaded" || item.status === "skipped");
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

  sessionList.innerHTML = items
    .map((session) => {
      const canUpload =
        (session.phase === "recorded" || session.phase === "failed") && session.hasLocalSnapshot;
      const canReplay = session.phase === "uploaded" && Boolean(session.recordingUrl);
      const canCopy = session.phase === "uploaded" && Boolean(session.recordingUrl);
      // Open remote package/folder in Drive or Dropbox when we have a recording URL or folder ref.
      const canOpenFolder =
        session.phase === "uploaded" &&
        Boolean(
          buildCloudRemoteOpenUrl({
            recordingUrl: session.recordingUrl,
            folderRef: session.recordingFolderId,
          }),
        );
      const canDelete = session.phase !== "uploading";
      const showProgress = session.phase === "uploading" || session.items.length > 0;
      return `
      <div class="session-item" data-session-id="${escapeHtml(session.id)}">
        <div class="session-item-header">
          <div class="session-item-title">${escapeHtml(formatPageLabel(session.tabUrl))}</div>
          <div class="session-item-badge phase-${session.phase}">${escapeHtml(getSessionStatusLabel(session))}</div>
        </div>
        <div class="session-item-meta">
          ${escapeHtml(formatDateTime(session.stopTime || session.startTime))}<br>
          Duration: ${escapeHtml(formatTime(session.elapsedMs))}
        </div>
        ${session.error ? `<div class="session-item-error">${escapeHtml(session.error)}</div>` : ""}
        ${
          showProgress
            ? `
          <div class="session-item-progress">
            <div class="session-progress-meta">${escapeHtml(session.message || "Waiting to upload")}</div>
            <div class="session-progress-summary">${formatBytes(session.uploadedBytes)} / ${formatBytes(session.totalBytes)} (${session.progress.toFixed(1)}%)</div>
            <div class="progress-items">${renderProgressItems(session.items, session.progress)}</div>
          </div>
        `
            : ""
        }
        <div class="session-item-actions">
          ${
            canUpload
              ? renderSessionActionButton({
                  action: "upload-session",
                  label: "Upload",
                  attrName: "data-session-id",
                  attrValue: session.id,
                  icon: getUploadIcon(),
                })
              : ""
          }
          ${
            canReplay
              ? renderSessionActionButton({
                  action: "open-replay",
                  label: "Replay",
                  attrName: "data-url",
                  attrValue: session.recordingUrl || "",
                  icon: getReplayIcon(),
                })
              : ""
          }
          ${
            canCopy
              ? renderSessionActionButton({
                  action: "copy-link",
                  label: "Copy link",
                  attrName: "data-url",
                  attrValue: session.recordingUrl || "",
                  icon: getCopyIcon(),
                })
              : ""
          }
          ${
            canOpenFolder
              ? renderSessionActionButton({
                  action: "open-remote",
                  label: "Open remote",
                  attrName: "data-recording-url",
                  attrValue: session.recordingUrl || "",
                  icon: getFolderIcon(),
                  extraAttrs: {
                    "data-folder-id": session.recordingFolderId || "",
                    "data-provider": resolveHistoryProvider(undefined, session.recordingUrl),
                  },
                })
              : ""
          }
          ${
            canDelete
              ? renderSessionActionButton({
                  action: "delete-session",
                  label: "Delete",
                  attrName: "data-session-id",
                  attrValue: session.id,
                  icon: getDeleteIcon(),
                })
              : ""
          }
        </div>
      </div>
    `;
    })
    .join("");
}

function getSessionShellSnapshot(session: RecordingSessionSummary): string {
  const shell = { ...session };
  for (const field of SESSION_PROGRESS_FIELDS) {
    delete shell[field];
  }
  return JSON.stringify(shell);
}

function getSessionProgressSnapshot(session: RecordingSessionSummary): string {
  return JSON.stringify({
    progress: session.progress,
    uploadedBytes: session.uploadedBytes,
    totalBytes: session.totalBytes,
    message: session.message,
    items: session.items,
  });
}

function isProgressOnlyStateUpdate(previous: PopupState | null, next: PopupState): boolean {
  if (!previous) {
    return false;
  }
  const prevStorage = getActiveStorageConnection(previous);
  const nextStorage = getActiveStorageConnection(next);
  if (
    prevStorage.isConnected !== nextStorage.isConnected ||
    prevStorage.provider !== nextStorage.provider
  ) {
    return false;
  }
  if (JSON.stringify(previous.recording) !== JSON.stringify(next.recording)) {
    return false;
  }
  if (JSON.stringify(previous.settings) !== JSON.stringify(next.settings)) {
    return false;
  }
  if (JSON.stringify(previous.uploadHistory) !== JSON.stringify(next.uploadHistory)) {
    return false;
  }
  if (previous.sessions.length !== next.sessions.length) {
    return false;
  }

  let hasUploadingProgressUpdate = false;
  const sessionsOnlyChangedProgress = next.sessions.every((session, index) => {
    const previousSession = previous.sessions[index];
    if (!previousSession || previousSession.id !== session.id) {
      return false;
    }
    if (getSessionShellSnapshot(previousSession) !== getSessionShellSnapshot(session)) {
      return false;
    }
    if (session.phase === "uploading" && previousSession.phase === "uploading") {
      hasUploadingProgressUpdate = true;
      return true;
    }
    return getSessionProgressSnapshot(previousSession) === getSessionProgressSnapshot(session);
  });

  return hasUploadingProgressUpdate && sessionsOnlyChangedProgress;
}

function updateSessionProgressSections(sessions: RecordingSessionSummary[]): boolean {
  for (const session of sessions) {
    if (session.phase !== "uploading") {
      continue;
    }

    const sessionElement = sessionList.querySelector<HTMLElement>(
      `.session-item[data-session-id="${CSS.escape(session.id)}"]`,
    );
    const progressElement = sessionElement?.querySelector<HTMLElement>(".session-item-progress");
    if (!progressElement) {
      return false;
    }

    progressElement.innerHTML = `
      <div class="session-progress-meta">${escapeHtml(session.message || "Waiting to upload")}</div>
      <div class="session-progress-summary">${formatBytes(session.uploadedBytes)} / ${formatBytes(session.totalBytes)} (${session.progress.toFixed(1)}%)</div>
      <div class="progress-items">${renderProgressItems(session.items, session.progress)}</div>
    `;
  }
  return true;
}

function renderPopupUploadHistory(
  history: UploadHistoryEntry[] | undefined,
  options: { animateLatestSuccess?: boolean } = {},
): void {
  const previousLatestUpload = currentUploadHistory[0] || null;
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
    hiddenCount > 0
      ? `<div class="history-empty">${hiddenCount} older upload${hiddenCount === 1 ? "" : "s"} hidden.</div>`
      : "",
  ].join("");
  const latestUpload = currentUploadHistory[0] || null;
  const shouldAnimateLatestSuccess =
    Boolean(options.animateLatestSuccess) &&
    Boolean(latestUpload) &&
    latestUpload?.id !== previousLatestUpload?.id &&
    (!previousLatestUpload || latestUpload.uploadedAt >= previousLatestUpload.uploadedAt);
  if (shouldAnimateLatestSuccess) {
    animatingUploadHistoryIds.add(latestUpload.id);
    clearTimeout(uploadHistoryAnimationTimeouts.get(latestUpload.id));
    uploadHistoryAnimationTimeouts.set(
      latestUpload.id,
      setTimeout(() => {
        animatingUploadHistoryIds.delete(latestUpload.id);
        uploadHistoryAnimationTimeouts.delete(latestUpload.id);
        popupUploadHistoryList
          .querySelector(".history-item.is-upload-success")
          ?.classList.remove("is-upload-success");
      }, 1000),
    );
  }
  if (latestUpload && animatingUploadHistoryIds.has(latestUpload.id)) {
    popupUploadHistoryList.querySelector(".history-item")?.classList.add("is-upload-success");
  }
}

function storageProviderDisplayName(provider: string | undefined): string {
  if (provider === "dropbox") return "Dropbox";
  return "Google Drive";
}

function normalizePopupStorageProvider(value: string | undefined | null): string {
  if (value === "dropbox" || value === "google-drive") {
    return value;
  }
  return "google-drive";
}

/**
 * Prefer `state.storage` (active provider). Fall back to googleDrive shim for
 * older persisted snapshots that predate the storage field.
 */
function getActiveStorageConnection(state: PopupState | null | undefined): {
  provider: string;
  isConnected: boolean;
} {
  if (state?.storage && typeof state.storage.isConnected === "boolean") {
    return {
      provider: normalizePopupStorageProvider(
        state.storage.provider || state.settings?.activeStorageProvider,
      ),
      isConnected: state.storage.isConnected,
    };
  }
  return {
    provider: normalizePopupStorageProvider(state?.settings?.activeStorageProvider),
    isConnected: Boolean(state?.googleDrive?.isConnected),
  };
}

function listConnectedProviderIds(): string[] {
  return ["google-drive", "dropbox"].filter((id) => connectedProviders.get(id));
}

function rebuildConnectedProviderSelect(preferred?: string): string | null {
  if (!storageProviderSelect) {
    return null;
  }
  const connected = listConnectedProviderIds();
  const preferredNorm = preferred ? normalizePopupStorageProvider(preferred) : "";
  const active =
    preferredNorm && connected.includes(preferredNorm) ? preferredNorm : connected[0] || null;

  storageProviderSelect.innerHTML = "";
  if (connected.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Connect a cloud first…";
    storageProviderSelect.append(opt);
    storageProviderSelect.value = "";
    storageProviderSelect.disabled = true;
    return null;
  }

  for (const id of connected) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = storageProviderDisplayName(id);
    storageProviderSelect.append(opt);
  }
  storageProviderSelect.disabled = false;
  storageProviderSelect.value = active || connected[0];
  return storageProviderSelect.value || null;
}

function updateStorageUI(_isConnected: boolean, provider?: string): void {
  const preferred = normalizePopupStorageProvider(
    provider ||
      latestPopupState?.storage?.provider ||
      latestPopupState?.settings?.activeStorageProvider,
  );
  // Prefer preferred only if that cloud is connected; otherwise first connected.
  const selected = rebuildConnectedProviderSelect(preferred);
  const anyConnected = listConnectedProviderIds().length > 0;
  const selectedConnected = Boolean(selected && connectedProviders.get(selected));

  const targetSlot = anyConnected ? connectedGoogleDriveSlot : mainGoogleDriveSlot;
  if (googleDriveSection.parentElement !== targetSlot) {
    targetSlot.appendChild(googleDriveSection);
  }

  if (storageProviderLabel) {
    storageProviderLabel.textContent = "Upload to";
  }

  if (selectedConnected && selected) {
    const name = storageProviderDisplayName(selected);
    googleDriveStatus.textContent = `${name} ready`;
    googleDriveStatus.classList.add("is-connected");
  } else {
    googleDriveStatus.textContent = "No cloud connected";
    googleDriveStatus.classList.remove("is-connected");
  }

  if (manageStorageBtn) {
    manageStorageBtn.textContent = anyConnected ? "Manage clouds" : "Connect clouds";
    manageStorageBtn.classList.toggle("btn-start", !anyConnected);
  }
  if (storageConnectHint) {
    storageConnectHint.textContent = anyConnected
      ? "Only connected clouds appear here. Open Manage clouds to connect or disconnect accounts."
      : "Connect Google Drive or Dropbox on the cloud page. This popup only switches among already-connected providers.";
  }
}

async function setActiveStorageProvider(provider: string): Promise<void> {
  const normalized = normalizePopupStorageProvider(provider);
  if (!connectedProviders.get(normalized)) {
    throw new Error(`${storageProviderDisplayName(normalized)} is not connected.`);
  }
  const result = (await chrome.runtime.sendMessage({
    action: "UPDATE_SETTINGS",
    data: { activeStorageProvider: normalized },
  })) as MessageResponse & { settings?: PopupState["settings"] };
  if (!result.ok) {
    throw new Error(result.error || "Could not switch storage provider.");
  }
  await refreshPopupFromStorage();
  void refreshAllProviderStatuses();
}

/** @deprecated Prefer updateStorageUI */
function updateGoogleDriveUI(isConnected: boolean): void {
  updateStorageUI(isConnected, latestPopupState?.storage?.provider);
}

function openStorageAuthPage(provider?: string): void {
  const url = new URL(chrome.runtime.getURL("storage-auth/storage-auth.html"));
  if (provider) {
    url.searchParams.set("provider", normalizePopupStorageProvider(provider));
  }
  chrome.tabs.create({ url: url.toString() });
  window.close();
}

function setCaptureUiVisibility(isVisible: boolean): void {
  recordingActions.classList.toggle("hidden", !isVisible);
  sessionQueueSection.classList.toggle("hidden", !isVisible);

  if (isVisible) {
    return;
  }

  removeRecordingBtn.classList.add("hidden");
  drawingSection.classList.add("hidden");
  setDrawButtonActive(false);
  recordingActions.classList.remove("has-unavailable-reason");
  recordingUnavailableMsg.classList.add("hidden");
  recordingUnavailableMsg.textContent = "";
  toggleBtn.disabled = false;
  toggleBtn.removeAttribute("title");
  statusBar.classList.add("hidden");
  stats.classList.add("hidden");
  sessionList.innerHTML = "";
  stopRecordingTimer();
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

function getLoadingIcon(): string {
  return `<span class="btn-spinner" aria-hidden="true"></span>`;
}

function setButtonLabel(button: HTMLButtonElement, icon: string, label: string): void {
  button.innerHTML = `${icon}<span>${escapeHtml(label)}</span>`;
}

function renderStopAndUploadLoading(recording: RecordingStatus | null): void {
  setButtonLabel(toggleBtn, getLoadingIcon(), "Stopping...");
  toggleBtn.className = "btn btn-stop is-loading";
  toggleBtn.disabled = true;
  toggleBtn.setAttribute("aria-busy", "true");
  toggleBtn.setAttribute("title", "Stopping recording and preparing upload");
  recordingActions.classList.add("is-recording");
  recordingActions.classList.remove("has-unavailable-reason");
  removeRecordingBtn.classList.remove("hidden");
  removeRecordingBtn.disabled = true;
  drawingSection.classList.add("hidden");
  setDrawButtonActive(false);
  recordingUnavailableMsg.classList.add("hidden");
  recordingUnavailableMsg.textContent = "";
  statusBar.classList.remove("hidden");
  stats.classList.remove("hidden");

  if (recording) {
    timerEl.textContent = formatTime(getLiveRecordingElapsedMs(recording));
  }
  stopRecordingTimer();
}

async function refreshActiveTabRecordingAvailability(): Promise<void> {
  const checkId = ++activeTabRecordingCheckId;
  activeTabRecordingError = "Checking whether this tab can be recorded.";
  if (
    getActiveStorageConnection(latestPopupState).isConnected &&
    !latestPopupState?.recording?.isRecording
  ) {
    updateRecordingUI(latestPopupState?.recording ?? null);
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (checkId !== activeTabRecordingCheckId) {
      return;
    }
    activeTabRecordingError = getRecordingTabTarget(tab).error;
  } catch (error) {
    if (checkId !== activeTabRecordingCheckId) {
      return;
    }
    activeTabRecordingError =
      (error as Error).message || "Cannot inspect the active tab for recording.";
  }

  if (getActiveStorageConnection(latestPopupState).isConnected) {
    updateRecordingUI(latestPopupState?.recording ?? null);
  }
}

function updateRecordingUI(recording: RecordingStatus | null): void {
  if (recording?.isRecording) {
    if (toggleActionMode === "stop") {
      renderStopAndUploadLoading(recording);
      return;
    }

    setButtonLabel(toggleBtn, getStopRecordingIcon(), "Stop & Upload");
    toggleBtn.className = "btn btn-stop";
    toggleBtn.removeAttribute("aria-busy");
    recordingActions.classList.add("is-recording");
    recordingActions.classList.remove("has-unavailable-reason");
    removeRecordingBtn.classList.remove("hidden");
    removeRecordingBtn.disabled = false;
    drawingSection.classList.remove("hidden");
    drawToggleBtn.disabled = false;
    void syncDrawButtonState();
    recordingUnavailableMsg.classList.add("hidden");
    recordingUnavailableMsg.textContent = "";
    toggleBtn.disabled = toggleActionInFlight;
    toggleBtn.removeAttribute("title");
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
  toggleBtn.removeAttribute("aria-busy");
  recordingActions.classList.remove("is-recording");
  removeRecordingBtn.classList.add("hidden");
  removeRecordingBtn.disabled = false;
  drawingSection.classList.add("hidden");
  setDrawButtonActive(false);
  statusBar.classList.add("hidden");
  stats.classList.add("hidden");
  const unavailableReason = activeTabRecordingError;
  toggleBtn.disabled = toggleActionInFlight || Boolean(unavailableReason);
  recordingActions.classList.toggle("has-unavailable-reason", Boolean(unavailableReason));
  recordingUnavailableMsg.classList.toggle("hidden", !unavailableReason);
  recordingUnavailableMsg.textContent = unavailableReason || "";
  if (unavailableReason) {
    toggleBtn.setAttribute("title", unavailableReason);
  } else {
    toggleBtn.removeAttribute("title");
  }
  stopRecordingTimer();
}

function handleStateUpdate(state: PopupState): void {
  const previousState = latestPopupState;
  latestPopupState = state;
  if (
    isProgressOnlyStateUpdate(previousState, state) &&
    updateSessionProgressSections(state.sessions)
  ) {
    return;
  }

  // Refresh multi-provider connection map so the select only lists connected clouds.
  void refreshAllProviderStatuses().then(() => {
    const selected = storageProviderSelect?.value || "";
    const canRecord = Boolean(selected && connectedProviders.get(selected));
    if (canRecord) {
      updateRecordingUI(state.recording);
      renderSessions(state.sessions);
      if (!state.recording?.isRecording) {
        void refreshActiveTabRecordingAvailability();
      }
    }
  });

  renderPopupUploadHistory(state.uploadHistory, {
    animateLatestSuccess: isUploadHistoryAnimationReady,
  });
}

async function refreshPopupFromStorage(): Promise<void> {
  const state = await loadStateFromStorage();
  if (state) {
    handleStateUpdate(state);
  }
}

async function refreshAllProviderStatuses(): Promise<void> {
  const providers = ["google-drive", "dropbox"] as const;
  try {
    await Promise.all(
      providers.map(async (provider) => {
        try {
          const result = (await chrome.runtime.sendMessage({
            action: "STORAGE_STATUS",
            data: { provider },
          })) as MessageResponse & { isConnected?: boolean };
          connectedProviders.set(provider, Boolean(result?.ok && result.isConnected));
        } catch {
          connectedProviders.set(provider, false);
        }
      }),
    );
  } catch {
    // Ignore warmup failures.
  }

  const preferred =
    latestPopupState?.storage?.provider ||
    latestPopupState?.settings?.activeStorageProvider ||
    "google-drive";
  const selected = rebuildConnectedProviderSelect(preferred);
  const anyConnected = listConnectedProviderIds().length > 0;

  // If active settings provider is not connected, switch to first connected.
  if (selected && selected !== preferred && connectedProviders.get(selected)) {
    try {
      await chrome.runtime.sendMessage({
        action: "UPDATE_SETTINGS",
        data: { activeStorageProvider: selected },
      });
      await refreshPopupFromStorage();
    } catch {
      // UI still shows connected list even if settings write fails.
    }
  }

  updateStorageUI(anyConnected, selected || preferred);
  setCaptureUiVisibility(anyConnected && Boolean(selected && connectedProviders.get(selected)));
}

/** @deprecated Prefer refreshAllProviderStatuses */
async function refreshStorageStatus(): Promise<void> {
  await refreshAllProviderStatuses();
}

function openExternalUrl(url: string): void {
  chrome.tabs.create({ url });
}

/** Open replay in the external/hosted player. */
function openReplayUrl(url: string): void {
  openExternalUrl(resolveReplayOpenUrl(url));
}

function openSettingsPage(): void {
  chrome.tabs.create({
    url: chrome.runtime.getURL("settings/settings.html"),
  });
  window.close();
}

toggleBtn.addEventListener("click", async () => {
  toggleActionInFlight = true;
  toggleBtn.disabled = true;
  errorMsg.classList.add("hidden");

  try {
    const currentState = await loadStateFromStorage();
    if (!getActiveStorageConnection(currentState).isConnected) {
      showError("Connect cloud storage before recording.");
      return;
    }

    const isRecording = currentState?.recording?.isRecording ?? false;
    toggleActionMode = isRecording ? "stop" : "start";

    if (isRecording) {
      renderStopAndUploadLoading(currentState?.recording ?? null);
      const result = (await chrome.runtime.sendMessage({
        action: "STOP_RECORDING",
      })) as MessageResponse;
      if (!result.ok) {
        showError(result.error || "Failed to stop recording");
      }
    } else {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const target = getRecordingTabTarget(tab);
      if (target.error) {
        activeTabRecordingError = target.error;
        updateRecordingUI(currentState?.recording ?? null);
        return;
      }
      const result = (await chrome.runtime.sendMessage({
        action: "START_RECORDING",
        tabId: tab.id,
      })) as MessageResponse;
      if (!result.ok) {
        showError(result.error || "Failed to start recording");
      }
    }
  } catch (error) {
    showError((error as Error).message);
  } finally {
    toggleActionInFlight = false;
    toggleActionMode = null;
    const state = await loadStateFromStorage();
    if (state) {
      handleStateUpdate(state);
    } else {
      toggleBtn.removeAttribute("aria-busy");
      toggleBtn.disabled = false;
    }
  }
});

function setDrawButtonActive(active: boolean): void {
  const label = active ? "Drawing" : "Draw";
  drawToggleBtn.classList.toggle("active", active);
  drawToggleBtn.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 19l7-7 3 3-7 7-3-3z"/>
      <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/>
      <path d="M2 2l7.586 7.586"/>
      <circle cx="11" cy="11" r="2"/>
    </svg>
    <span>${escapeHtml(label)}</span>
  `;
}

function expandShortHex(color: string): string {
  const match = /^#([0-9a-f]{3})$/i.exec(color);
  if (!match) {
    return color;
  }
  const [r, g, b] = match[1].split("");
  return `#${r}${r}${g}${g}${b}${b}`;
}

function setSelectedDrawColor(color: string, options: { updateInput?: boolean } = {}): void {
  const normalized = normalizeDrawColor(color) || DEFAULT_DRAW_COLOR;
  selectedDrawColor = normalized;
  const expanded = expandShortHex(normalized);

  for (const swatch of drawColorSwatches.querySelectorAll<HTMLButtonElement>(
    ".drawing-color-swatch",
  )) {
    const isSelected = swatch.dataset.color === normalized;
    swatch.classList.toggle("is-selected", isSelected);
    swatch.setAttribute("aria-pressed", isSelected ? "true" : "false");
  }

  if (options.updateInput !== false) {
    drawColorInput.value = expanded.length === 7 ? expanded : DEFAULT_DRAW_COLOR;
  }
}

function renderDrawColorSwatches(): void {
  drawColorSwatches.innerHTML = "";
  for (const color of DRAW_COLOR_PRESETS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "drawing-color-swatch";
    button.dataset.color = color;
    button.style.backgroundColor = color;
    button.title = color;
    button.setAttribute("aria-label", `Pen color ${color}`);
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => {
      void applyDrawColor(color);
    });
    drawColorSwatches.appendChild(button);
  }
  setSelectedDrawColor(selectedDrawColor);
}

async function applyDrawColor(color: string): Promise<void> {
  const normalized = normalizeDrawColor(color);
  if (!normalized || drawColorUpdateInFlight) {
    return;
  }

  const previous = selectedDrawColor;
  setSelectedDrawColor(normalized);
  drawColorUpdateInFlight = true;
  errorMsg.classList.add("hidden");

  try {
    const response = (await chrome.runtime.sendMessage({
      target: "service-worker",
      action: "SET_DRAWING_COLOR",
      data: { color: normalized },
    })) as { ok: boolean; color?: string; error?: string };
    if (!response?.ok) {
      setSelectedDrawColor(previous);
      showError(response?.error || "Could not update drawing color.");
      return;
    }
    if (response.color) {
      setSelectedDrawColor(response.color);
    }
  } catch (error) {
    setSelectedDrawColor(previous);
    showError((error as Error).message);
  } finally {
    drawColorUpdateInFlight = false;
  }
}

async function syncDrawButtonState(): Promise<void> {
  try {
    const response = (await chrome.runtime.sendMessage({
      target: "service-worker",
      action: "GET_DRAWING_OVERLAY_STATE",
    })) as { ok: boolean; active?: boolean; color?: string; error?: string };
    if (response?.ok) {
      setDrawButtonActive(Boolean(response.active));
      if (response.color) {
        setSelectedDrawColor(response.color);
      }
    }
  } catch {
    // Ignore warmup/injection errors.
  }
}

renderDrawColorSwatches();

drawColorInput.addEventListener("input", () => {
  const color = normalizeDrawColor(drawColorInput.value);
  if (color) {
    setSelectedDrawColor(color, { updateInput: false });
  }
});

drawColorInput.addEventListener("change", () => {
  void applyDrawColor(drawColorInput.value);
});

drawToggleBtn.addEventListener("click", async () => {
  drawToggleBtn.disabled = true;
  errorMsg.classList.add("hidden");

  try {
    const response = (await chrome.runtime.sendMessage({
      target: "service-worker",
      action: "TOGGLE_DRAWING_OVERLAY",
    })) as { ok: boolean; active?: boolean; error?: string };
    if (!response?.ok) {
      showError(response?.error || "Could not toggle drawing overlay.");
      return;
    }
    setDrawButtonActive(Boolean(response.active));
  } catch (error) {
    showError((error as Error).message);
  } finally {
    drawToggleBtn.disabled = false;
  }
});

removeRecordingBtn.addEventListener("click", async () => {
  removeRecordingBtn.disabled = true;
  errorMsg.classList.add("hidden");

  try {
    const result = (await chrome.runtime.sendMessage({
      action: "REMOVE_RECORDING",
    })) as MessageResponse;
    if (!result.ok) {
      showError(result.error || "Failed to remove recording");
      return;
    }
    showToast("Recording removed.", 1800, { variant: "success" });
  } catch (error) {
    showError((error as Error).message);
  } finally {
    removeRecordingBtn.disabled = false;
  }
});

toastCloseBtn.addEventListener("click", () => {
  hideToast();
});

toastLinkEl.addEventListener("click", (event) => {
  event.preventDefault();
  const url = toastLinkEl.getAttribute("href");
  if (url) {
    openExternalUrl(url);
    hideToast();
  }
});

settingsPageBtn.addEventListener("click", openSettingsPage);

storageProviderSelect?.addEventListener("change", async () => {
  const raw = storageProviderSelect.value;
  if (!raw) {
    return;
  }
  const provider = normalizePopupStorageProvider(raw);
  if (!connectedProviders.get(provider)) {
    showError("Connect that cloud on the cloud page first.");
    openStorageAuthPage(provider);
    return;
  }
  storageProviderSelect.disabled = true;
  errorMsg.classList.add("hidden");
  try {
    await setActiveStorageProvider(provider);
  } catch (error) {
    showError((error as Error).message);
    const current = getActiveStorageConnection(latestPopupState);
    rebuildConnectedProviderSelect(current.provider);
    updateStorageUI(current.isConnected, current.provider);
  } finally {
    storageProviderSelect.disabled = listConnectedProviderIds().length === 0;
  }
});

manageStorageBtn?.addEventListener("click", () => {
  openStorageAuthPage(
    storageProviderSelect?.value || latestPopupState?.settings?.activeStorageProvider || undefined,
  );
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
      openReplayUrl(url);
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

  if (action === "open-remote" || action === "open-folder") {
    const openUrl = buildCloudRemoteOpenUrl({
      provider: target.getAttribute("data-provider"),
      recordingUrl: target.getAttribute("data-recording-url"),
      folderRef: target.getAttribute("data-folder-id"),
      fileId: target.getAttribute("data-file-id"),
    });
    if (openUrl) {
      openExternalUrl(openUrl);
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
      const result = (await chrome.runtime.sendMessage({
        action: "UPLOAD_TO_GOOGLE_DRIVE",
        data: { sessionId },
      })) as MessageResponse;
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
      const result = (await chrome.runtime.sendMessage({
        action: "DELETE_SESSION",
        data: { sessionId },
      })) as MessageResponse;
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

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
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
        const result = (await chrome.runtime.sendMessage({
          action: "DELETE_UPLOAD_HISTORY_ENTRY",
          data: { historyEntryId },
        })) as MessageResponse & { state?: PopupState; uploadHistory?: UploadHistoryEntry[] };

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

chrome.runtime.onMessage.addListener((message: { action?: string; state?: PopupState }) => {
  if (message.action !== "POPUP_STATE_UPDATED" || !message.state) {
    return false;
  }

  handleStateUpdate(message.state);
  return false;
});

async function initPopup(): Promise<void> {
  // Paint the auth UI from the active-provider local-storage mirror first so the
  // popup does not flash wrong Connected/Not connected for Dropbox vs Drive
  // before the service worker re-hydrates session state.
  const mirrored = await loadMirroredStorageConnected();
  if (mirrored.isConnected !== null) {
    updateStorageUI(mirrored.isConnected, mirrored.provider);
    if (mirrored.isConnected) {
      setCaptureUiVisibility(true);
    }
  }

  const initialState = await loadStateFromStorage();
  if (initialState) {
    handleStateUpdate(initialState);
  } else if (mirrored.isConnected === null) {
    renderSessions([]);
    renderPopupUploadHistory([], { animateLatestSuccess: false });
  }

  try {
    const settingsResult = (await chrome.runtime.sendMessage({
      action: "GET_SETTINGS",
    })) as MessageResponse & {
      uploadHistory?: UploadHistoryEntry[];
    };
    if (settingsResult.ok && Array.isArray(settingsResult.uploadHistory)) {
      renderPopupUploadHistory(settingsResult.uploadHistory, { animateLatestSuccess: false });
    }
  } catch {
    // Ignore worker warmup errors.
  }
  isUploadHistoryAnimationReady = true;

  await refreshStorageStatus();
  await refreshActiveTabRecordingAvailability();

  const unsubscribe = subscribeToStateChanges((state) => {
    handleStateUpdate(state);
  });
  const refreshRecordingTarget = () => {
    void refreshActiveTabRecordingAvailability();
  };
  chrome.tabs.onActivated.addListener(refreshRecordingTarget);
  chrome.tabs.onUpdated.addListener(refreshRecordingTarget);

  window.addEventListener("unload", () => {
    stopRecordingTimer();
    unsubscribe();
    chrome.tabs.onActivated.removeListener(refreshRecordingTarget);
    chrome.tabs.onUpdated.removeListener(refreshRecordingTarget);
  });
}

githubLinkBtn.addEventListener("click", () => {
  openExternalUrl(GITHUB_REPO_URL);
});

contributeLinkBtn.addEventListener("click", () => {
  openExternalUrl(GITHUB_ISSUES_URL);
});

attachThemeToggle("theme-toggle-btn", "theme-toggle-icon");

void initPopup();
