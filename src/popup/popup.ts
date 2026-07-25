/**
 * Drives the extension popup UI and service-worker message interactions.
 */

import { DEFAULT_DRAW_COLOR, DRAW_COLOR_PRESETS, normalizeDrawColor } from "../shared/drawing";
import { buildFeedbackDiagnostics, validateFeedbackMessage } from "../shared/feedback";
import { resolveReplayOpenUrl } from "../shared/player-host";
import { getRecordingTabTarget } from "../shared/recording-target";
import { buildCloudRemoteOpenUrl, resolveHistoryProvider } from "../shared/storage-provider";
import { attachThemeToggle, type ThemeToggleController } from "../shared/theme";
import { attachLanguageSwitch, type UiLanguage } from "../shared/ui-language";
import {
  escapeHtml,
  formatDateTime,
  formatPageLabel,
  formatTime,
  getVisibleUploadHistory,
  HISTORY_PAGE_PATH,
  handleUploadHistoryAction,
  renderUploadHistoryList,
  setUploadHistoryUiLabels,
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

type PopupLanguage = UiLanguage;

const TRANSLATIONS: Record<PopupLanguage, Record<string, string>> = {
  en: {
    "actions.startRecording": "Start Recording",
    "actions.stopUpload": "Stop & Upload",
    "actions.stopping": "Stopping...",
    "actions.stoppingTitle": "Stopping recording and preparing upload",
    "actions.discard": "Discard",
    "actions.openSettings": "Open settings",
    "actions.openHistory": "History",
    "actions.toggleTheme": "Toggle theme",
    "theme.system": "System",
    "theme.light": "Light",
    "theme.dark": "Dark",
    "theme.aria": "Theme: {label}",
    "theme.titleSystem": "Theme: {label} (follows OS). Click to cycle System → Light → Dark.",
    "theme.titleFixed": "Theme: {label}. Click to cycle System → Light → Dark.",
    "stats.console": "Console",
    "stats.network": "Network",
    "drawing.sectionAria": "Drawing overlay",
    "drawing.toggleTitle": "Toggle drawing pen",
    "drawing.draw": "Draw",
    "drawing.drawing": "Drawing",
    "drawing.color": "Color",
    "drawing.colorGroupAria": "Drawing pen color",
    "drawing.customColor": "Custom pen color",
    "drawing.customColorTitle": "Custom color",
    "drawing.hint": "Toggle with Ctrl/Cmd+Shift+D",
    "drawing.penColorAria": "Pen color {color}",
    "storage.uploadTo": "Upload to",
    "storage.noCloud": "No cloud connected",
    "storage.ready": "{name} ready",
    "storage.connectClouds": "Connect clouds",
    "storage.manageClouds": "Manage clouds",
    "storage.selectAria": "Connected storage provider",
    "storage.connectFirst": "Connect a cloud first…",
    "storage.hintDisconnected":
      "Connect Google Drive or Dropbox on the cloud page. This popup only switches among already-connected providers.",
    "storage.hintConnected":
      "Only connected clouds appear here. Open Manage clouds to connect or disconnect accounts.",
    "storage.notConnected": "{name} is not connected.",
    "storage.switchFailed": "Could not switch storage provider.",
    "storage.connectBeforeRecord": "Connect cloud storage before recording.",
    "storage.connectCloudFirst": "Connect that cloud on the cloud page first.",
    "sections.captureQueue": "Capture Queue",
    "sections.latestUpload": "Latest Upload",
    "password.sectionTitle": "Package password",
    "password.label": "Zip password",
    "password.placeholder": "Set password for new uploads",
    "password.set": "Set password",
    "password.save": "Save password",
    "password.cancel": "Cancel",
    "password.clear": "Remove password",
    "password.saving": "Saving…",
    "password.statusOn": "Password set",
    "password.statusOff": "Not set",
    "password.hintNone": "New uploads will not require a zip password.",
    "password.hintConfigured": "New uploads will be zip-protected with the saved password.",
    "password.saveSuccess": "Zip password saved.",
    "password.clearSuccess": "Zip password removed.",
    "password.saveFailed": "Could not update zip password.",
    "password.required": "Enter a password to save.",
    "footer.feedback": "Feedback",
    "feedback.sectionAria": "Send feedback",
    "feedback.label": "Feedback",
    "feedback.placeholder": "Describe a bug, idea, or question…",
    "feedback.hint":
      "Creates a public GitHub issue. Includes extension version, browser, OS, and locale only. Do not include secrets or passwords.",
    "feedback.submit": "Submit",
    "feedback.cancel": "Cancel",
    "feedback.sending": "Sending…",
    "feedback.success": "Feedback submitted.",
    "feedback.failed": "Could not submit feedback.",
    "session.empty": "No pending capture records.",
    "session.duration": "Duration: {time}",
    "session.waitingUpload": "Waiting to upload",
    "session.progressAria": "Progress {percent}%",
    "session.status.ready": "Ready",
    "session.status.uploading": "Uploading",
    "session.status.uploaded": "Uploaded",
    "session.status.failed": "Failed",
    "session.action.upload": "Upload",
    "session.action.replay": "Replay",
    "session.action.copyLink": "Copy link",
    "session.action.openRemote": "Open remote",
    "session.action.delete": "Delete",
    "history.empty": "No uploads yet.",
    "history.duration": "Duration: {time}",
    "history.unknownTime": "Unknown time",
    "history.unknownPage": "Unknown page",
    "history.olderHidden": "{count} older upload{plural} hidden.",
    "messages.checkingTab": "Checking whether this tab can be recorded.",
    "messages.cannotInspectTab": "Cannot inspect the active tab for recording.",
    "messages.stopFailed": "Failed to stop recording",
    "messages.startFailed": "Failed to start recording",
    "messages.removeFailed": "Failed to remove recording",
    "messages.removed": "Recording removed.",
    "messages.copySuccess": "Replay link copied.",
    "messages.copyFailed": "Failed to copy replay link",
    "messages.uploadFailed": "Failed to upload session",
    "messages.deleteSessionFailed": "Failed to delete session",
    "messages.deleteHistoryFailed": "Failed to delete history item",
    "messages.drawColorFailed": "Could not update drawing color.",
    "messages.drawToggleFailed": "Could not toggle drawing overlay.",
  },
  vi: {
    "actions.startRecording": "Bắt đầu ghi",
    "actions.stopUpload": "Dừng & Upload",
    "actions.stopping": "Đang dừng...",
    "actions.stoppingTitle": "Đang dừng ghi và chuẩn bị upload",
    "actions.discard": "Hủy",
    "actions.openSettings": "Mở cài đặt",
    "actions.openHistory": "Lịch sử",
    "actions.toggleTheme": "Chuyển giao diện",
    "theme.system": "Hệ thống",
    "theme.light": "Sáng",
    "theme.dark": "Tối",
    "theme.aria": "Giao diện: {label}",
    "theme.titleSystem": "Giao diện: {label} (theo OS). Bấm để chuyển Hệ thống → Sáng → Tối.",
    "theme.titleFixed": "Giao diện: {label}. Bấm để chuyển Hệ thống → Sáng → Tối.",
    "stats.console": "Console",
    "stats.network": "Network",
    "drawing.sectionAria": "Lớp vẽ",
    "drawing.toggleTitle": "Bật/tắt bút vẽ",
    "drawing.draw": "Vẽ",
    "drawing.drawing": "Đang vẽ",
    "drawing.color": "Màu",
    "drawing.colorGroupAria": "Màu bút vẽ",
    "drawing.customColor": "Màu bút tùy chỉnh",
    "drawing.customColorTitle": "Màu tùy chỉnh",
    "drawing.hint": "Bật/tắt bằng Ctrl/Cmd+Shift+D",
    "drawing.penColorAria": "Màu bút {color}",
    "storage.uploadTo": "Upload lên",
    "storage.noCloud": "Chưa kết nối cloud",
    "storage.ready": "{name} sẵn sàng",
    "storage.connectClouds": "Kết nối cloud",
    "storage.manageClouds": "Quản lý cloud",
    "storage.selectAria": "Nhà cung cấp lưu trữ đã kết nối",
    "storage.connectFirst": "Hãy kết nối cloud trước…",
    "storage.hintDisconnected":
      "Kết nối Google Drive hoặc Dropbox trên trang cloud. Popup chỉ chuyển giữa các provider đã kết nối.",
    "storage.hintConnected":
      "Chỉ hiện các cloud đã kết nối. Mở Quản lý cloud để kết nối hoặc ngắt kết nối.",
    "storage.notConnected": "{name} chưa được kết nối.",
    "storage.switchFailed": "Không chuyển được nhà cung cấp lưu trữ.",
    "storage.connectBeforeRecord": "Hãy kết nối cloud trước khi ghi.",
    "storage.connectCloudFirst": "Hãy kết nối cloud đó trên trang cloud trước.",
    "sections.captureQueue": "Hàng đợi capture",
    "sections.latestUpload": "Upload gần nhất",
    "password.sectionTitle": "Mật khẩu package",
    "password.label": "Mật khẩu zip",
    "password.placeholder": "Đặt mật khẩu cho upload mới",
    "password.set": "Đặt mật khẩu",
    "password.save": "Lưu mật khẩu",
    "password.cancel": "Hủy",
    "password.clear": "Xóa mật khẩu",
    "password.saving": "Đang lưu…",
    "password.statusOn": "Đã đặt mật khẩu",
    "password.statusOff": "Chưa đặt",
    "password.hintNone": "Upload mới sẽ không yêu cầu mật khẩu zip.",
    "password.hintConfigured": "Upload mới sẽ được bảo vệ zip bằng mật khẩu đã lưu.",
    "password.saveSuccess": "Đã lưu mật khẩu zip.",
    "password.clearSuccess": "Đã xóa mật khẩu zip.",
    "password.saveFailed": "Không cập nhật được mật khẩu zip.",
    "password.required": "Nhập mật khẩu để lưu.",
    "footer.feedback": "Góp ý",
    "feedback.sectionAria": "Gửi góp ý",
    "feedback.label": "Góp ý",
    "feedback.placeholder": "Mô tả lỗi, ý tưởng hoặc câu hỏi…",
    "feedback.hint":
      "Tạo issue GitHub công khai. Chỉ kèm version extension, browser, OS và locale. Không gửi mật khẩu hay secret.",
    "feedback.submit": "Gửi",
    "feedback.cancel": "Hủy",
    "feedback.sending": "Đang gửi…",
    "feedback.success": "Đã gửi góp ý.",
    "feedback.failed": "Không gửi được góp ý.",
    "session.empty": "Không có bản ghi đang chờ.",
    "session.duration": "Thời lượng: {time}",
    "session.waitingUpload": "Đang chờ upload",
    "session.progressAria": "Tiến độ {percent}%",
    "session.status.ready": "Sẵn sàng",
    "session.status.uploading": "Đang upload",
    "session.status.uploaded": "Đã upload",
    "session.status.failed": "Thất bại",
    "session.action.upload": "Upload",
    "session.action.replay": "Replay",
    "session.action.copyLink": "Sao chép link",
    "session.action.openRemote": "Mở remote",
    "session.action.delete": "Xóa",
    "history.empty": "Chưa có upload nào.",
    "history.duration": "Thời lượng: {time}",
    "history.unknownTime": "Thời gian không rõ",
    "history.unknownPage": "Trang không rõ",
    "history.olderHidden": "{count} upload cũ hơn bị ẩn.",
    "messages.checkingTab": "Đang kiểm tra tab này có ghi được không.",
    "messages.cannotInspectTab": "Không kiểm tra được tab đang mở để ghi.",
    "messages.stopFailed": "Không dừng được bản ghi",
    "messages.startFailed": "Không bắt đầu được bản ghi",
    "messages.removeFailed": "Không hủy được bản ghi",
    "messages.removed": "Đã hủy bản ghi.",
    "messages.copySuccess": "Đã sao chép link replay.",
    "messages.copyFailed": "Không sao chép được link replay",
    "messages.uploadFailed": "Không upload được phiên",
    "messages.deleteSessionFailed": "Không xóa được phiên",
    "messages.deleteHistoryFailed": "Không xóa được mục lịch sử",
    "messages.drawColorFailed": "Không cập nhật được màu vẽ.",
    "messages.drawToggleFailed": "Không bật/tắt được lớp vẽ.",
  },
};

let currentLanguage: PopupLanguage = "en";
let themeToggleUi: ThemeToggleController | null = null;

function t(key: string, replacements: Record<string, string> = {}): string {
  const template = TRANSLATIONS[currentLanguage][key] || TRANSLATIONS.en[key] || key;
  return Object.entries(replacements).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, value),
    template,
  );
}

function applyStaticTranslations(): void {
  document.documentElement.lang = currentLanguage;

  setUploadHistoryUiLabels({
    empty: t("history.empty"),
    duration: t("history.duration"),
    replay: t("session.action.replay"),
    copyLink: t("session.action.copyLink"),
    openRemote: t("session.action.openRemote"),
    delete: t("session.action.delete"),
    unknownTime: t("history.unknownTime"),
    unknownPage: t("history.unknownPage"),
  });

  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((element) => {
    element.textContent = t(element.dataset.i18n || "");
  });

  document.querySelectorAll<HTMLElement>("[data-i18n-aria]").forEach((element) => {
    element.setAttribute("aria-label", t(element.dataset.i18nAria || ""));
  });

  document.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((element) => {
    element.setAttribute("title", t(element.dataset.i18nTitle || ""));
  });

  document
    .querySelectorAll<HTMLTextAreaElement | HTMLInputElement>("[data-i18n-placeholder]")
    .forEach((element) => {
      element.placeholder = t(element.dataset.i18nPlaceholder || "");
    });

  settingsPageBtn.setAttribute("aria-label", t("actions.openSettings"));
  settingsPageBtn.setAttribute("title", t("actions.openSettings"));
  themeToggleUi?.refreshLabels();
  const feedbackToggle = document.getElementById("feedback-toggle-btn");
  if (feedbackToggle) {
    feedbackToggle.setAttribute("aria-label", t("footer.feedback"));
    feedbackToggle.setAttribute("title", t("footer.feedback"));
  }
}

/**
 * Refresh all language-sensitive UI after a locale change (or first attach).
 * Dynamic regions (recording controls, storage card, sessions, history) are
 * re-rendered from the latest worker snapshot so labels stay consistent.
 */
function applyTranslations(): void {
  applyStaticTranslations();

  const connection = getActiveStorageConnection(latestPopupState);
  updateStorageUI(connection.isConnected, connection.provider);

  if (connection.isConnected || listConnectedProviderIds().length > 0) {
    const selected = storageProviderSelect?.value;
    const canRecord = Boolean(selected && connectedProviders.get(selected));
    if (canRecord || getActiveStorageConnection(latestPopupState).isConnected) {
      updateRecordingUI(latestPopupState?.recording ?? null);
      renderSessions(latestPopupState?.sessions);
    }
  }

  renderPopupUploadHistory(currentUploadHistory, { animateLatestSuccess: false });
  renderDrawColorSwatches();
  updateZipPasswordUi(Boolean(latestPopupState?.settings?.zipPasswordConfigured));
  updateSessionQueueVisibility(latestPopupState?.sessions);

  // Preserve draw active label if the pen is currently on.
  if (drawToggleBtn.classList.contains("active")) {
    setDrawButtonActive(true);
  } else {
    setDrawButtonActive(false);
  }
}

/**
 * Popup UI controller.
 *
 * The popup is disposable browser UI: it renders the latest persisted service
 * worker state, sends user commands back to the worker, and keeps transient DOM
 * details such as timers/toasts local. Durable recording truth must stay in the
 * service worker because this window can close at any time.
 */
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
const zipPasswordSummary = document.getElementById("zip-password-summary")!;
const zipPasswordForm = document.getElementById("zip-password-form")!;
const zipPasswordStatus = document.getElementById("zip-password-status")!;
const zipPasswordInput = document.getElementById("zip-password-input") as HTMLInputElement;
const zipPasswordHint = document.getElementById("zip-password-hint")!;
const zipPasswordSetBtn = document.getElementById("zip-password-set-btn") as HTMLButtonElement;
const zipPasswordSaveBtn = document.getElementById("zip-password-save-btn") as HTMLButtonElement;
const zipPasswordCancelBtn = document.getElementById(
  "zip-password-cancel-btn",
) as HTMLButtonElement;
const zipPasswordClearBtn = document.getElementById("zip-password-clear-btn") as HTMLButtonElement;
let zipPasswordConfigured = false;
let zipPasswordFormOpen = false;
const errorMsg = document.getElementById("error-msg")!;
const toastEl = document.getElementById("toast")!;
const toastIconEl = document.getElementById("toast-icon")!;
const toastMessageEl = document.getElementById("toast-message")!;

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

const feedbackWrap = document.getElementById("feedback-wrap") as HTMLElement | null;
const feedbackToggleBtn = document.getElementById("feedback-toggle-btn") as HTMLButtonElement;
const feedbackPanel = document.getElementById("feedback-panel")!;
const feedbackMessageInput = document.getElementById("feedback-message") as HTMLTextAreaElement;
const feedbackSubmitBtn = document.getElementById("feedback-submit-btn") as HTMLButtonElement;
const feedbackCancelBtn = document.getElementById("feedback-cancel-btn") as HTMLButtonElement;

let timerInterval: ReturnType<typeof setInterval> | null = null;
let timerRecording: RecordingStatus | null = null;
let toastTimeout: ReturnType<typeof setTimeout> | null = null;
let currentUploadHistory: UploadHistoryEntry[] = [];
const pendingDeletedHistoryIds = new Set<string>();
const animatingUploadHistoryIds = new Set<string>();
const uploadHistoryAnimationTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
let isUploadHistoryAnimationReady = false;
let latestPopupState: PopupState | null = null;
let activeTabRecordingError: string | null = null;
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
  options: { variant?: ToastVariant } = {},
): void {
  const variant = options.variant || "success";
  toastIconEl.textContent = getToastIcon(variant);
  toastMessageEl.textContent = normalizeToastMessage(message);
  toastEl.classList.remove("toast-success", "toast-info", "toast-error");
  toastEl.classList.add(`toast-${variant}`);
  toastEl.setAttribute("role", variant === "error" ? "alert" : "status");
  toastEl.setAttribute("aria-live", variant === "error" ? "assertive" : "polite");
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
      aria-label="${escapeHtml(t("session.progressAria", { percent: percent.toFixed(1) }))}"
    ></div>
  `;
}

function getSessionStatusLabel(session: RecordingSessionSummary): string {
  switch (session.phase) {
    case "recorded":
      return t("session.status.ready");
    case "uploading":
      return t("session.status.uploading");
    case "uploaded":
      return t("session.status.uploaded");
    case "failed":
      return t("session.status.failed");
    default:
      return session.phase;
  }
}

function getPendingSessions(
  sessions: RecordingSessionSummary[] | undefined,
): RecordingSessionSummary[] {
  return Array.isArray(sessions) ? sessions.filter((session) => session.phase !== "uploaded") : [];
}

/**
 * Capture queue is only shown when there is at least one non-uploaded session
 * and capture controls are available (cloud connected).
 */
function updateSessionQueueVisibility(sessions?: RecordingSessionSummary[]): void {
  const pending = getPendingSessions(sessions ?? latestPopupState?.sessions);
  const captureAvailable = !recordingActions.classList.contains("hidden");
  sessionQueueSection.classList.toggle("hidden", !(captureAvailable && pending.length > 0));
}

function setZipPasswordFormOpen(open: boolean): void {
  zipPasswordFormOpen = open;
  zipPasswordForm.classList.toggle("hidden", !open);
  zipPasswordSummary.classList.toggle("hidden", open);
  if (open) {
    zipPasswordInput.value = "";
    zipPasswordInput.focus();
  }
}

function updateZipPasswordUi(configured: boolean): void {
  zipPasswordConfigured = configured;
  zipPasswordStatus.textContent = configured ? t("password.statusOn") : t("password.statusOff");
  zipPasswordStatus.classList.toggle("is-on", configured);
  zipPasswordStatus.classList.toggle("is-off", !configured);
  zipPasswordHint.textContent = configured ? t("password.hintConfigured") : t("password.hintNone");
  zipPasswordClearBtn.classList.toggle("hidden", !configured);
  zipPasswordClearBtn.disabled = !configured;
  // Do not auto-open the form; only close if it is not already open.
  if (!zipPasswordFormOpen) {
    zipPasswordForm.classList.add("hidden");
    zipPasswordSummary.classList.remove("hidden");
  }
}

function renderSessions(sessions: RecordingSessionSummary[] | undefined): void {
  const items = getPendingSessions(sessions);
  updateSessionQueueVisibility(items);

  if (items.length === 0) {
    sessionList.innerHTML = "";
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
          ${escapeHtml(t("session.duration", { time: formatTime(session.elapsedMs) }))}
        </div>
        ${session.error ? `<div class="session-item-error">${escapeHtml(session.error)}</div>` : ""}
        ${
          showProgress
            ? `
          <div class="session-item-progress">
            <div class="session-progress-meta">${escapeHtml(session.message || t("session.waitingUpload"))}</div>
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
                  label: t("session.action.upload"),
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
                  label: t("session.action.replay"),
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
                  label: t("session.action.copyLink"),
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
                  label: t("session.action.openRemote"),
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
                  label: t("session.action.delete"),
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
      <div class="session-progress-meta">${escapeHtml(session.message || t("session.waitingUpload"))}</div>
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
      ? `<div class="history-empty">${escapeHtml(
          t("history.olderHidden", {
            count: String(hiddenCount),
            plural: hiddenCount === 1 ? "" : "s",
          }),
        )}</div>`
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
    opt.textContent = t("storage.connectFirst");
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
    storageProviderLabel.textContent = t("storage.uploadTo");
  }

  if (selectedConnected && selected) {
    const name = storageProviderDisplayName(selected);
    googleDriveStatus.textContent = t("storage.ready", { name });
    googleDriveStatus.classList.add("is-connected");
  } else {
    googleDriveStatus.textContent = t("storage.noCloud");
    googleDriveStatus.classList.remove("is-connected");
  }

  if (manageStorageBtn) {
    manageStorageBtn.textContent = anyConnected
      ? t("storage.manageClouds")
      : t("storage.connectClouds");
    manageStorageBtn.classList.toggle("btn-start", !anyConnected);
  }
  if (storageConnectHint) {
    storageConnectHint.textContent = anyConnected
      ? t("storage.hintConnected")
      : t("storage.hintDisconnected");
  }
}

async function setActiveStorageProvider(provider: string): Promise<void> {
  const normalized = normalizePopupStorageProvider(provider);
  if (!connectedProviders.get(normalized)) {
    throw new Error(t("storage.notConnected", { name: storageProviderDisplayName(normalized) }));
  }
  const result = (await chrome.runtime.sendMessage({
    action: "UPDATE_SETTINGS",
    data: { activeStorageProvider: normalized },
  })) as MessageResponse & { settings?: PopupState["settings"] };
  if (!result.ok) {
    throw new Error(result.error || t("storage.switchFailed"));
  }
  await refreshPopupFromStorage();
  void refreshAllProviderStatuses();
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

  if (isVisible) {
    updateSessionQueueVisibility(latestPopupState?.sessions);
    return;
  }

  sessionQueueSection.classList.add("hidden");
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
  setButtonLabel(toggleBtn, getLoadingIcon(), t("actions.stopping"));
  toggleBtn.className = "btn btn-stop is-loading";
  toggleBtn.disabled = true;
  toggleBtn.setAttribute("aria-busy", "true");
  toggleBtn.setAttribute("title", t("actions.stoppingTitle"));
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
  activeTabRecordingError = t("messages.checkingTab");
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
    activeTabRecordingError = (error as Error).message || t("messages.cannotInspectTab");
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

    setButtonLabel(toggleBtn, getStopRecordingIcon(), t("actions.stopUpload"));
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

  setButtonLabel(toggleBtn, getStartRecordingIcon(), t("actions.startRecording"));
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
  updateZipPasswordUi(Boolean(state.settings?.zipPasswordConfigured));
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
      showError(t("storage.connectBeforeRecord"));
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
        showError(result.error || t("messages.stopFailed"));
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
        showError(result.error || t("messages.startFailed"));
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
  const label = active ? t("drawing.drawing") : t("drawing.draw");
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
    button.setAttribute("aria-label", t("drawing.penColorAria", { color }));
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
      showError(response?.error || t("messages.drawColorFailed"));
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

// Color swatches are painted by applyTranslations() (and again on language change).

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
      showError(response?.error || t("messages.drawToggleFailed"));
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
      showError(result.error || t("messages.removeFailed"));
      return;
    }
    showToast(t("messages.removed"), 1800, { variant: "success" });
  } catch (error) {
    showError((error as Error).message);
  } finally {
    removeRecordingBtn.disabled = false;
  }
});

toastCloseBtn.addEventListener("click", () => {
  hideToast();
});

settingsPageBtn.addEventListener("click", openSettingsPage);

storageProviderSelect?.addEventListener("change", async () => {
  const raw = storageProviderSelect.value;
  if (!raw) {
    return;
  }
  const provider = normalizePopupStorageProvider(raw);
  if (!connectedProviders.get(provider)) {
    showError(t("storage.connectCloudFirst"));
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
      showSuccess(t("messages.copySuccess"));
    } catch (error) {
      showError((error as Error).message || t("messages.copyFailed"));
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
        showError(result.error || t("messages.uploadFailed"));
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
        showError(result.error || t("messages.deleteSessionFailed"));
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
        showSuccess(t("messages.copySuccess"));
      } catch (error) {
        showError((error as Error).message || t("messages.copyFailed"));
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
          showError(result.error || t("messages.deleteHistoryFailed"));
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

async function saveZipPassword(options: { clear?: boolean } = {}): Promise<void> {
  const clear = Boolean(options.clear);
  const password = zipPasswordInput.value;
  if (!clear && !password.trim()) {
    showToast(t("password.required"), 2400, { variant: "error" });
    return;
  }

  zipPasswordSaveBtn.disabled = true;
  zipPasswordCancelBtn.disabled = true;
  zipPasswordSetBtn.disabled = true;
  zipPasswordClearBtn.disabled = true;
  const previousSaveLabel = zipPasswordSaveBtn.textContent;
  zipPasswordSaveBtn.textContent = t("password.saving");

  try {
    const result = (await chrome.runtime.sendMessage({
      action: "UPDATE_SETTINGS",
      data: clear ? { clearZipPassword: true } : { zipPassword: password, clearZipPassword: false },
    })) as MessageResponse & { settings?: PopupState["settings"] };

    if (!result?.ok) {
      showToast(result?.error || t("password.saveFailed"), 3200, { variant: "error" });
      return;
    }

    zipPasswordInput.value = "";
    const configured = clear ? false : Boolean(result.settings?.zipPasswordConfigured ?? true);
    zipPasswordFormOpen = false;
    updateZipPasswordUi(configured);
    setZipPasswordFormOpen(false);
    if (latestPopupState?.settings) {
      latestPopupState = {
        ...latestPopupState,
        settings: {
          ...latestPopupState.settings,
          zipPasswordConfigured: configured,
        },
      };
    }
    showToast(clear ? t("password.clearSuccess") : t("password.saveSuccess"), 1800, {
      variant: "success",
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    showToast(detail || t("password.saveFailed"), 3200, { variant: "error" });
  } finally {
    zipPasswordSaveBtn.disabled = false;
    zipPasswordCancelBtn.disabled = false;
    zipPasswordSetBtn.disabled = false;
    zipPasswordSaveBtn.textContent = previousSaveLabel || t("password.save");
    zipPasswordClearBtn.disabled = !zipPasswordConfigured;
  }
}

zipPasswordSetBtn.addEventListener("click", () => {
  setZipPasswordFormOpen(true);
});

zipPasswordCancelBtn.addEventListener("click", () => {
  zipPasswordInput.value = "";
  setZipPasswordFormOpen(false);
});

zipPasswordSaveBtn.addEventListener("click", () => {
  void saveZipPassword();
});

zipPasswordClearBtn.addEventListener("click", () => {
  void saveZipPassword({ clear: true });
});

zipPasswordInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void saveZipPassword();
  }
  if (event.key === "Escape") {
    event.preventDefault();
    zipPasswordInput.value = "";
    setZipPasswordFormOpen(false);
  }
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

function setFeedbackPanelOpen(open: boolean): void {
  feedbackPanel.classList.toggle("hidden", !open);
  feedbackToggleBtn.setAttribute("aria-expanded", open ? "true" : "false");
  feedbackWrap?.classList.toggle("is-open", open);
  if (open) {
    feedbackMessageInput.focus();
  }
}

feedbackToggleBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  const open = feedbackPanel.classList.contains("hidden");
  setFeedbackPanelOpen(open);
});

feedbackCancelBtn.addEventListener("click", () => {
  setFeedbackPanelOpen(false);
});

document.addEventListener("click", (event) => {
  if (feedbackPanel.classList.contains("hidden")) {
    return;
  }
  const target = event.target as Node | null;
  if (target && feedbackWrap?.contains(target)) {
    return;
  }
  setFeedbackPanelOpen(false);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !feedbackPanel.classList.contains("hidden")) {
    setFeedbackPanelOpen(false);
    feedbackToggleBtn.focus();
  }
});

feedbackSubmitBtn.addEventListener("click", async () => {
  const validated = validateFeedbackMessage(feedbackMessageInput.value);
  if (!validated.ok) {
    showToast(validated.error, 2800, { variant: "error" });
    return;
  }

  feedbackSubmitBtn.disabled = true;
  feedbackMessageInput.disabled = true;
  feedbackCancelBtn.disabled = true;
  feedbackSubmitBtn.textContent = t("feedback.sending");

  try {
    const result = (await chrome.runtime.sendMessage({
      action: "SUBMIT_FEEDBACK",
      data: {
        message: validated.message,
        diagnostics: buildFeedbackDiagnostics(),
      },
    })) as MessageResponse;

    if (!result?.ok) {
      const error = result?.error || t("feedback.failed");
      showToast(error, 4200, { variant: "error" });
      return;
    }

    feedbackMessageInput.value = "";
    setFeedbackPanelOpen(false);
    showToast(result.message || t("feedback.success"), 4200, {
      variant: "success",
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    showToast(detail || t("feedback.failed"), 4200, { variant: "error" });
  } finally {
    feedbackSubmitBtn.disabled = false;
    feedbackMessageInput.disabled = false;
    feedbackCancelBtn.disabled = false;
    feedbackSubmitBtn.textContent = t("feedback.submit");
  }
});

themeToggleUi = attachThemeToggle("theme-toggle-btn", "theme-toggle-icon", {
  getLabels: () => ({
    system: t("theme.system"),
    light: t("theme.light"),
    dark: t("theme.dark"),
    aria: t("theme.aria"),
    titleSystem: t("theme.titleSystem"),
    titleFixed: t("theme.titleFixed"),
  }),
});

currentLanguage = attachLanguageSwitch({
  onChange: (language) => {
    currentLanguage = language;
    applyTranslations();
  },
});
applyTranslations();

void initPopup();
