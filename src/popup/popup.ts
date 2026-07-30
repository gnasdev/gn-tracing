/**
 * Drives the extension popup UI and service-worker message interactions.
 */

import { buttonSpinnerHtml } from "../shared/button-loading";
import { DEFAULT_DRAW_COLOR, DRAW_COLOR_PRESETS, normalizeDrawColor } from "../shared/drawing";
import { buildFeedbackDiagnostics, validateFeedbackMessage } from "../shared/feedback";
import {
  hostnameFromTabUrl,
  normalizeInstantReplayAllowedDomains,
  normalizeInstantReplayDomainPattern,
  tabUrlMatchesInstantReplayAllowlist,
} from "../shared/instant-replay-domain";
import {
  INSTANT_REPLAY_WINDOW_SECONDS_DEFAULT,
  INSTANT_REPLAY_WINDOW_SECONDS_MAX,
  INSTANT_REPLAY_WINDOW_SECONDS_MIN,
  normalizeInstantReplayWindowSeconds,
} from "../shared/instant-replay-window";
import { resolveReplayOpenUrl } from "../shared/player-host";
import { getRecordingTabTarget } from "../shared/recording-target";
import {
  attachSettingsForm,
  SETTINGS_FORM_TRANSLATIONS,
  type SettingsFormController,
} from "../shared/settings-form-ui";
import { buildCloudRemoteOpenUrl, resolveHistoryProvider } from "../shared/storage-provider";
import { attachThemeToggle, type ThemeToggleController } from "../shared/theme";
import { attachLanguageSwitch, type UiLanguage } from "../shared/ui-language";
import {
  escapeHtml,
  formatDateTime,
  formatPageLabel,
  formatTime,
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
import { PopupDialogHost } from "./dialog-host";

type PopupLanguage = UiLanguage;

const POPUP_TRANSLATIONS: Record<PopupLanguage, Record<string, string>> = {
  en: {
    "actions.startRecording": "Start Recording",
    "actions.captureInstantReplay": "Capture",
    "actions.captureInstantReplayTitle": "Capture Instant Replay lookback",
    "actions.capturingInstantReplay": "Capturing…",
    "actions.enableInstantReplay": "Enable",
    "actions.enableInstantReplayOn": "On",
    "actions.enableInstantReplayTitle": "Turn always-on Instant Replay on or off",
    "actions.instantReplaySettings": "Settings",
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
    "storage.manageCloudsTitle": "Manage clouds",
    "storage.manageCloudsLead":
      "Connect Google Drive or Dropbox. The extension can only access files it uploads — not your full cloud drive. OAuth may briefly close this popup; reopen it after signing in.",
    "storage.cloudInfoTitle": "Cloud storage access",
    "storage.cloudInfoBody":
      "Connecting a cloud only authorizes GN Tracing for files this extension uploads (and related package metadata). It does not get full access to browse or read your entire Drive or Dropbox. OAuth uses limited scopes so recordings stay in the extension’s own files.",
    "storage.connected": "Connected",
    "storage.notConnectedStatus": "Not connected",
    "storage.working": "Working…",
    "storage.disconnect": "Disconnect",
    "storage.connectProvider": "Connect {name}",
    "storage.selectAria": "Connected storage provider",
    "storage.connectFirst": "Connect a cloud first…",
    "storage.notConnected": "{name} is not connected.",
    "storage.switchFailed": "Could not switch storage provider.",
    "storage.connectBeforeRecord": "Connect cloud storage before recording.",
    "storage.connectCloudFirst": "Connect that cloud first.",
    "storage.folderLabel": "Upload folder",
    "storage.folderPlaceholderDrive": "/gn-tracing, folder ID, or Drive link",
    "storage.folderPlaceholderDropbox": "/gn-tracing or blank for root",
    "storage.folderHintDefault": "Using upload folder: /gn-tracing.",
    "storage.folderHintRoot": "Using cloud root folder.",
    "storage.folderHintPath": "Using folder: {value}.",
    "storage.folderHintId": "Resolved folder ID: {value}",
    "storage.folderHintDropbox": "Dropbox path (e.g. /gn-tracing). Created on upload if missing.",
    "storage.folderSaveFailed": "Could not save upload folder.",
    "storage.folderSaved": "Upload folder saved.",
    "storage.edit": "Edit",
    "storage.done": "Done",
    "storage.cancel": "Cancel",
    "storage.summaryConnected": "{name} · {folder}",
    "storage.summaryDisconnected": "No cloud connected",
    "sections.captureQueue": "Capture Queue",
    "sections.latestUpload": "Latest Upload",
    "sections.uploadHistory": "Upload history",
    "dialog.close": "Close",
    "history.entryEmpty": "No uploads yet.",
    "history.entrySummary": "{count} upload{plural} · latest {page}",
    "history.summaryEmpty": "Browse your recent uploads here once recordings are uploaded.",
    "history.summaryCount": "{count} upload{plural} saved locally.",
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
    "password.saveSuccess": "Zip password saved.",
    "password.clearSuccess": "Zip password removed.",
    "password.saveFailed": "Could not update zip password.",
    "password.required": "Enter a password to save.",
    "instantReplay.sectionTitle": "Instant Replay",
    "instantReplay.groupAria": "Instant Replay",
    "instantReplay.settingsTitle": "Instant Replay settings",
    "instantReplay.settingsAria": "Instant Replay settings",
    "instantReplay.infoTitle": "Instant Replay",
    "instantReplay.infoBody":
      "Instant Replay quietly remembers the last few minutes of the page while you browse — so when something breaks, you can save that moment without recording the whole session.\n\n• Enable — start (or stop) this background memory.\n• Capture — save the recent lookback, then annotate and upload if you want.\n• Settings — how long to keep, and which sites may collect console/network (Chrome may show a “debugging this tab” banner on those sites).\n\nNothing is uploaded until you capture and save. Until then, it stays only on your computer.",
    "instantReplay.windowLabel": "Keep last",
    "instantReplay.domainsLabel": "Allowed domains (CDP)",
    "instantReplay.addThisSite": "Add this site",
    "instantReplay.addThisSiteDone": "Added",
    "instantReplay.alreadyOnList": "Already added",
    "instantReplay.domainsEmpty":
      "None yet — click “Add this site” while on the page you want to debug.",
    "instantReplay.domainAdded": "Added {domain} to Instant Replay.",
    "instantReplay.domainRemoved": "Removed {domain} from Instant Replay.",
    "instantReplay.domainExists": "{domain} is already on the allowlist.",
    "instantReplay.domainInvalid":
      "Could not read a host from the active tab (open an http/https page).",
    "instantReplay.removeDomain": "Remove {domain}",
    "instantReplay.enableFirst": "Enable Instant Replay first, then add this site.",
    "instantReplay.hint":
      "When on, keeps a rolling DOM lookback. Console/network use CDP (debugger banner) only on allowed domains. After a bug, click Instant Replay to annotate, then save to upload. Nothing leaves your browser until you save.",
    "instantReplay.saveFailed": "Could not update Instant Replay settings.",
    "instantReplay.windowSaved": "Instant Replay window saved.",
    "instantReplay.enabledSaved": "Instant Replay enabled.",
    "instantReplay.disabledSaved": "Instant Replay disabled.",
    "instantReplay.captureFailed": "Could not capture Instant Replay.",
    "instantReplay.disabledTitle": "Enable Instant Replay first",
    "instantReplay.domainNotAllowedTitle":
      "Instant Replay only works on allowed domains — add this site first",
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
    "messages.checkingTab": "Checking whether this tab can be recorded.",
    "messages.cannotInspectTab": "Cannot inspect the active tab for recording.",
    "messages.stopFailed": "Failed to stop recording",
    "messages.startFailed": "Failed to start recording",
    "messages.removeFailed": "Failed to remove recording",
    "messages.screenshotFailed": "Could not capture a screenshot of this tab",
    "actions.screenshot": "Screenshot",
    "actions.screenshotTitle": "Capture and annotate a screenshot of this tab",
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
    "actions.captureInstantReplay": "Capture",
    "actions.captureInstantReplayTitle": "Capture lookback Instant Replay",
    "actions.capturingInstantReplay": "Đang capture…",
    "actions.enableInstantReplay": "Bật",
    "actions.enableInstantReplayOn": "Đang bật",
    "actions.enableInstantReplayTitle": "Bật/tắt Instant Replay luôn chạy",
    "actions.instantReplaySettings": "Cài đặt",
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
    "storage.manageCloudsTitle": "Quản lý cloud",
    "storage.manageCloudsLead":
      "Kết nối Google Drive hoặc Dropbox. Extension chỉ truy cập file do chính nó upload — không đọc toàn bộ cloud. OAuth có thể đóng popup; mở lại sau khi đăng nhập.",
    "storage.cloudInfoTitle": "Quyền truy cập cloud",
    "storage.cloudInfoBody":
      "Kết nối cloud chỉ cấp quyền cho GN Tracing với các file extension này upload (và metadata package liên quan). Extension không được quyền duyệt hay đọc toàn bộ Drive/Dropbox của bạn. OAuth dùng scope hạn chế để recording nằm trong file của extension.",
    "storage.connected": "Đã kết nối",
    "storage.notConnectedStatus": "Chưa kết nối",
    "storage.working": "Đang xử lý…",
    "storage.disconnect": "Ngắt kết nối",
    "storage.connectProvider": "Kết nối {name}",
    "storage.selectAria": "Nhà cung cấp lưu trữ đã kết nối",
    "storage.connectFirst": "Hãy kết nối cloud trước…",
    "storage.notConnected": "{name} chưa được kết nối.",
    "storage.switchFailed": "Không chuyển được nhà cung cấp lưu trữ.",
    "storage.connectBeforeRecord": "Hãy kết nối cloud trước khi ghi.",
    "storage.connectCloudFirst": "Hãy kết nối cloud đó trước.",
    "storage.folderLabel": "Thư mục upload",
    "storage.folderPlaceholderDrive": "/gn-tracing, folder ID, hoặc link Drive",
    "storage.folderPlaceholderDropbox": "/gn-tracing hoặc để trống cho root",
    "storage.folderHintDefault": "Đang dùng thư mục upload: /gn-tracing.",
    "storage.folderHintRoot": "Đang dùng thư mục gốc trên cloud.",
    "storage.folderHintPath": "Đang dùng thư mục: {value}.",
    "storage.folderHintId": "Folder ID đã resolve: {value}",
    "storage.folderHintDropbox": "Đường dẫn Dropbox (vd. /gn-tracing). Tạo khi upload nếu chưa có.",
    "storage.folderSaveFailed": "Không lưu được thư mục upload.",
    "storage.folderSaved": "Đã lưu thư mục upload.",
    "storage.edit": "Sửa",
    "storage.done": "Xong",
    "storage.cancel": "Hủy",
    "storage.summaryConnected": "{name} · {folder}",
    "storage.summaryDisconnected": "Chưa kết nối cloud",
    "sections.captureQueue": "Hàng đợi capture",
    "sections.latestUpload": "Upload gần nhất",
    "sections.uploadHistory": "Lịch sử upload",
    "dialog.close": "Đóng",
    "history.entryEmpty": "Chưa có upload.",
    "history.entrySummary": "{count} upload · gần nhất {page}",
    "history.summaryEmpty": "Các bản ghi sau khi upload sẽ hiện tại đây.",
    "history.summaryCount": "{count} upload được lưu cục bộ.",
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
    "password.saveSuccess": "Đã lưu mật khẩu zip.",
    "password.clearSuccess": "Đã xóa mật khẩu zip.",
    "password.saveFailed": "Không cập nhật được mật khẩu zip.",
    "password.required": "Nhập mật khẩu để lưu.",
    "instantReplay.sectionTitle": "Instant Replay",
    "instantReplay.groupAria": "Instant Replay",
    "instantReplay.settingsTitle": "Cài đặt Instant Replay",
    "instantReplay.settingsAria": "Cài đặt Instant Replay",
    "instantReplay.infoTitle": "Instant Replay",
    "instantReplay.infoBody":
      "Instant Replay âm thầm nhớ vài phút gần nhất trên trang bạn đang xem. Khi lỗi xảy ra, bạn lưu lại khoảnh khắc đó — không cần ghi cả phiên.\n\n• Enable — bật/tắt bộ nhớ nền này.\n• Capture — lưu lookback vừa rồi; có thể chú thích rồi upload nếu muốn.\n• Settings — giữ bao lâu, và site nào được thu console/network (trên các site đó Chrome có thể hiện banner “đang gỡ lỗi tab”).\n\nChưa bấm Capture và lưu thì không có gì rời máy — dữ liệu chỉ nằm trên máy bạn.",
    "instantReplay.windowLabel": "Giữ lại",
    "instantReplay.domainsLabel": "Domain được phép (CDP)",
    "instantReplay.addThisSite": "Thêm site này",
    "instantReplay.addThisSiteDone": "Đã thêm",
    "instantReplay.alreadyOnList": "Đã có",
    "instantReplay.domainsEmpty": "Chưa có — mở trang cần debug rồi bấm “Thêm site này”.",
    "instantReplay.domainAdded": "Đã thêm {domain} vào Instant Replay.",
    "instantReplay.domainRemoved": "Đã gỡ {domain} khỏi Instant Replay.",
    "instantReplay.domainExists": "{domain} đã có trong danh sách.",
    "instantReplay.domainInvalid": "Không đọc được host từ tab hiện tại (mở trang http/https).",
    "instantReplay.removeDomain": "Gỡ {domain}",
    "instantReplay.enableFirst": "Bật Instant Replay trước, rồi mới thêm site.",
    "instantReplay.hint":
      "Khi bật, giữ lookback DOM. Console/network dùng CDP (banner debugger) chỉ trên domain được phép. Gặp bug thì bấm Capture để chú thích, rồi lưu để upload. Không rời máy cho đến khi bạn lưu.",
    "instantReplay.saveFailed": "Không cập nhật được Instant Replay.",
    "instantReplay.windowSaved": "Đã lưu cửa sổ Instant Replay.",
    "instantReplay.enabledSaved": "Đã bật Instant Replay.",
    "instantReplay.disabledSaved": "Đã tắt Instant Replay.",
    "instantReplay.captureFailed": "Không capture được Instant Replay.",
    "instantReplay.disabledTitle": "Bật Instant Replay trong cài đặt trước",
    "instantReplay.domainNotAllowedTitle":
      "Instant Replay chỉ dùng trên domain được phép — hãy thêm site này trước",
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
    "messages.checkingTab": "Đang kiểm tra tab này có ghi được không.",
    "messages.cannotInspectTab": "Không kiểm tra được tab đang mở để ghi.",
    "messages.stopFailed": "Không dừng được bản ghi",
    "messages.startFailed": "Không bắt đầu được bản ghi",
    "messages.removeFailed": "Không hủy được bản ghi",
    "messages.screenshotFailed": "Không chụp được màn hình tab này",
    "actions.screenshot": "Chụp màn hình",
    "actions.screenshotTitle": "Chụp và chú thích màn hình tab này",
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

const TRANSLATIONS: Record<PopupLanguage, Record<string, string>> = {
  en: { ...SETTINGS_FORM_TRANSLATIONS.en, ...POPUP_TRANSLATIONS.en },
  vi: { ...SETTINGS_FORM_TRANSLATIONS.vi, ...POPUP_TRANSLATIONS.vi },
};

let currentLanguage: PopupLanguage = "en";
let themeToggleUi: ThemeToggleController | null = null;
let settingsForm: SettingsFormController | null = null;

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
  settingsForm?.refreshFieldInfoLabels();
  refreshSectionInfoButtons();
  themeToggleUi?.refreshLabels();
  const feedbackToggle = document.getElementById("feedback-toggle-btn");
  if (feedbackToggle) {
    feedbackToggle.setAttribute("aria-label", t("footer.feedback"));
    feedbackToggle.setAttribute("title", t("footer.feedback"));
  }
}

const SECTION_INFO: Record<string, { titleKey: string; bodyKey: string }> = {
  "instant-replay": {
    titleKey: "instantReplay.infoTitle",
    bodyKey: "instantReplay.infoBody",
  },
  "manage-cloud": {
    titleKey: "storage.cloudInfoTitle",
    bodyKey: "storage.cloudInfoBody",
  },
};

let activeSectionInfoKey: string | null = null;
let activeSectionInfoButton: HTMLButtonElement | null = null;

function isSectionInfoPopoverOpen(): boolean {
  return Boolean(settingInfoPopover?.matches(":popover-open"));
}

function positionSectionInfoPopover(anchor: HTMLElement): void {
  if (!settingInfoPopover) {
    return;
  }
  const gap = 8;
  const margin = 12;
  const rect = anchor.getBoundingClientRect();
  const popRect = settingInfoPopover.getBoundingClientRect();
  let top = rect.bottom + gap;
  let left = rect.left;
  if (top + popRect.height > window.innerHeight - margin) {
    top = rect.top - popRect.height - gap;
  }
  if (left + popRect.width > window.innerWidth - margin) {
    left = window.innerWidth - popRect.width - margin;
  }
  top = Math.max(margin, top);
  left = Math.max(margin, left);
  settingInfoPopover.style.top = `${Math.round(top)}px`;
  settingInfoPopover.style.left = `${Math.round(left)}px`;
}

function closeSectionInfoPopover(): void {
  if (settingInfoPopover && isSectionInfoPopoverOpen()) {
    settingInfoPopover.hidePopover();
  }
  if (activeSectionInfoButton) {
    activeSectionInfoButton.setAttribute("aria-expanded", "false");
  }
  activeSectionInfoKey = null;
  activeSectionInfoButton = null;
}

function openSectionInfoPopover(sectionKey: string, anchor: HTMLButtonElement): void {
  if (!settingInfoPopover || !settingInfoPopoverTitle || !settingInfoPopoverBody) {
    return;
  }
  const help = SECTION_INFO[sectionKey];
  if (!help) {
    return;
  }
  if (activeSectionInfoKey === sectionKey && isSectionInfoPopoverOpen()) {
    closeSectionInfoPopover();
    return;
  }
  if (activeSectionInfoButton && activeSectionInfoButton !== anchor) {
    activeSectionInfoButton.setAttribute("aria-expanded", "false");
  }
  settingInfoPopoverTitle.textContent = t(help.titleKey);
  settingInfoPopoverBody.textContent = t(help.bodyKey);
  activeSectionInfoKey = sectionKey;
  activeSectionInfoButton = anchor;
  anchor.setAttribute("aria-expanded", "true");
  if (!isSectionInfoPopoverOpen()) {
    settingInfoPopover.showPopover();
  }
  positionSectionInfoPopover(anchor);
}

function refreshSectionInfoButtons(): void {
  document.querySelectorAll<HTMLButtonElement>(".section-info-btn").forEach((button) => {
    button.setAttribute("aria-label", t("info.buttonLabel"));
    button.title = t("info.buttonLabel");
  });
  if (
    activeSectionInfoKey &&
    settingInfoPopover &&
    isSectionInfoPopoverOpen() &&
    activeSectionInfoButton
  ) {
    const help = SECTION_INFO[activeSectionInfoKey];
    if (help && settingInfoPopoverTitle && settingInfoPopoverBody) {
      settingInfoPopoverTitle.textContent = t(help.titleKey);
      settingInfoPopoverBody.textContent = t(help.bodyKey);
      positionSectionInfoPopover(activeSectionInfoButton);
    }
  }
}

function attachSectionInfoButtons(): void {
  document.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>(
      ".section-info-btn",
    );
    if (!button?.dataset.sectionInfo) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    openSectionInfoPopover(button.dataset.sectionInfo, button);
  });
  settingInfoPopover?.addEventListener("toggle", (event) => {
    const toggleEvent = event as ToggleEvent;
    if (toggleEvent.newState === "closed" && activeSectionInfoButton) {
      activeSectionInfoButton.setAttribute("aria-expanded", "false");
      activeSectionInfoKey = null;
      activeSectionInfoButton = null;
    }
  });
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
  if (isPopupDialogOpen("manage-clouds")) {
    renderManageCloudsProviderList();
  }
  renderDrawColorSwatches();
  updateZipPasswordUi(Boolean(latestPopupState?.settings?.zipPasswordConfigured));
  applyInstantReplaySettingsFromSnapshot(latestPopupState?.settings);
  updateInstantReplayControls({
    recordingActive: Boolean(latestPopupState?.recording?.isRecording),
  });
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
const screenshotBtn = document.getElementById("screenshot-btn") as HTMLButtonElement;
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
const zipPasswordSetBtn = document.getElementById("zip-password-set-btn") as HTMLButtonElement;
const zipPasswordSaveBtn = document.getElementById("zip-password-save-btn") as HTMLButtonElement;
const zipPasswordCancelBtn = document.getElementById(
  "zip-password-cancel-btn",
) as HTMLButtonElement;
const zipPasswordClearBtn = document.getElementById("zip-password-clear-btn") as HTMLButtonElement;
const instantReplayBtn = document.getElementById("instant-replay-btn") as HTMLButtonElement | null;
const instantReplayEnableBtn = document.getElementById(
  "instant-replay-enable-btn",
) as HTMLButtonElement | null;
const instantReplayControls = document.getElementById("instant-replay-controls");
const instantReplaySettingsBtn = document.getElementById(
  "instant-replay-settings-btn",
) as HTMLButtonElement | null;
const instantReplayDialog = document.getElementById("instant-replay-dialog");
const instantReplayPanel = document.getElementById("instant-replay-panel");
const instantReplaySettingsCloseBtn = document.getElementById(
  "instant-replay-settings-close-btn",
) as HTMLButtonElement | null;
const manageCloudsDialog = document.getElementById("manage-clouds-dialog");
const manageCloudsPanel = document.getElementById("manage-clouds-panel");
const manageCloudsCloseBtn = document.getElementById(
  "manage-clouds-close-btn",
) as HTMLButtonElement | null;
const popupProviderList = document.getElementById("popup-provider-list");
const uploadHistoryDialog = document.getElementById("upload-history-dialog");
const uploadHistoryPanel = document.getElementById("upload-history-panel");
const uploadHistoryCloseBtn = document.getElementById(
  "upload-history-close-btn",
) as HTMLButtonElement | null;
const uploadHistoryEntrySummary = document.getElementById("upload-history-entry-summary");
const uploadHistoryDialogSummary = document.getElementById("upload-history-dialog-summary");
const settingsDialog = document.getElementById("settings-dialog");
const settingsCloseBtn = document.getElementById("settings-close-btn") as HTMLButtonElement | null;
const settingsFormRoot = document.getElementById("settings-form-root");
const settingInfoPopover = document.getElementById("setting-info-popover");
const settingInfoPopoverTitle = document.getElementById("setting-info-title");
const settingInfoPopoverBody = document.getElementById("setting-info-body");
const instantReplayWindowInput = document.getElementById(
  "instant-replay-window",
) as HTMLInputElement | null;
const instantReplayWindowValue = document.getElementById("instant-replay-window-value");
const instantReplayDomainsList = document.getElementById("instant-replay-domains-list");
const instantReplayAddSiteBtn = document.getElementById(
  "instant-replay-add-site-btn",
) as HTMLButtonElement | null;
let zipPasswordConfigured = false;
let zipPasswordFormOpen = false;
let instantReplayEnabled = false;
let instantReplayWindowSeconds = INSTANT_REPLAY_WINDOW_SECONDS_DEFAULT;
let instantReplayAllowedDomains: string[] = [];
let instantReplayWindowSaveInFlight = false;
let instantReplayEnableSaveInFlight = false;
let instantReplayCaptureInFlight = false;
let instantReplayDomainSaveInFlight = false;
type PopupDialogId =
  | "feedback"
  | "instant-replay"
  | "manage-clouds"
  | "upload-history"
  | "settings";
const popupDialogHost = new PopupDialogHost<PopupDialogId>();
type PopupDialogEntry = {
  root: HTMLElement | null;
  trigger?: HTMLButtonElement | null;
  focusOnOpen?: HTMLElement | null;
  onOpen?: () => void;
};
const popupDialogEntries = new Map<PopupDialogId, PopupDialogEntry>();
const manageCloudsBusy = new Set<"google-drive" | "dropbox">();
const manageCloudsErrors = new Map<"google-drive" | "dropbox", string>();
/** Host just added — chip + button feedback until next update. */
let instantReplayJustAddedDomain: string | null = null;
let instantReplayAddButtonFeedbackTimeout: ReturnType<typeof setTimeout> | null = null;
const errorMsg = document.getElementById("error-msg")!;
const toastEl = document.getElementById("toast")!;
const toastIconEl = document.getElementById("toast-icon")!;
const toastMessageEl = document.getElementById("toast-message")!;

const toastCloseBtn = document.getElementById("toast-close-btn") as HTMLButtonElement;

const googleDriveSection = document.getElementById("google-drive-section")!;
const storageProviderLabel = document.getElementById("storage-provider-label");
const storageProviderSelect = document.getElementById(
  "storage-provider-select",
) as HTMLSelectElement | null;
const manageStorageBtn = document.getElementById("manage-storage-btn") as HTMLButtonElement | null;
const storageFolderInput = document.getElementById(
  "storage-folder-input",
) as HTMLInputElement | null;
const storageFolderHint = document.getElementById("storage-folder-hint");
const storageSummary = document.getElementById("storage-summary");
const storageEditor = document.getElementById("storage-editor");
const storageSummaryLine = document.getElementById("storage-summary-line");
const storageEditBtn = document.getElementById("storage-edit-btn") as HTMLButtonElement | null;
const storageEditorDoneBtn = document.getElementById(
  "storage-editor-done-btn",
) as HTMLButtonElement | null;
const storageEditorCancelBtn = document.getElementById(
  "storage-editor-cancel-btn",
) as HTMLButtonElement | null;
let storageEditorOpen = false;
let storageEditorSnapshot: { provider: string; folderInput: string } | null = null;

/** Connected flags for all providers — popup only lists these in the select. */
const connectedProviders = new Map<string, boolean>([
  ["google-drive", false],
  ["dropbox", false],
]);
const popupUploadHistoryList = document.getElementById("popup-upload-history-list")!;
const uploadHistoryPageBtn = document.getElementById(
  "upload-history-page-btn",
) as HTMLButtonElement;

const feedbackToggleBtn = document.getElementById("feedback-toggle-btn") as HTMLButtonElement;
const feedbackDialog = document.getElementById("feedback-dialog");
const feedbackPanel = document.getElementById("feedback-panel");
const feedbackCloseBtn = document.getElementById("feedback-close-btn") as HTMLButtonElement | null;
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
/** Latest active-tab URL for Instant Replay allowlist checks (http/https only). */
let activeTabUrl: string | null = null;
let toggleActionInFlight = false;
let toggleActionMode: "start" | "stop" | null = null;
let activeTabRecordingCheckId = 0;
let activeTabRecordingCheckInFlight = false;
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
 * Source of truth for Instant Replay allowlist is `chrome.storage.local`
 * (upload settings). Session popup state can lag after SW restart / page
 * navigation, so always re-hydrate IR fields from local before painting.
 */
async function hydrateInstantReplaySettingsFromLocal(): Promise<void> {
  try {
    const result = await chrome.storage.local.get(UPLOAD_SETTINGS_KEY);
    const stored = result[UPLOAD_SETTINGS_KEY] as
      | {
          instantReplayEnabled?: unknown;
          instantReplayWindowSeconds?: unknown;
          instantReplayAllowedDomains?: unknown;
        }
      | undefined;
    if (!stored || typeof stored !== "object") {
      return;
    }
    if (typeof stored.instantReplayEnabled === "boolean") {
      instantReplayEnabled = stored.instantReplayEnabled;
    }
    if (
      typeof stored.instantReplayWindowSeconds === "number" ||
      typeof stored.instantReplayWindowSeconds === "string"
    ) {
      instantReplayWindowSeconds = normalizeInstantReplayWindowSeconds(
        stored.instantReplayWindowSeconds,
        instantReplayWindowSeconds,
      );
    }
    if (Array.isArray(stored.instantReplayAllowedDomains)) {
      instantReplayAllowedDomains = normalizeInstantReplayAllowedDomains(
        stored.instantReplayAllowedDomains,
      );
    }
  } catch {
    // Ignore local read failures; session / GET_SETTINGS may still apply.
  }
}

function applyInstantReplaySettingsFromSnapshot(
  settings:
    | {
        instantReplayEnabled?: unknown;
        instantReplayWindowSeconds?: unknown;
        instantReplayAllowedDomains?: unknown;
      }
    | null
    | undefined,
): void {
  if (!settings || typeof settings !== "object") {
    return;
  }
  if (typeof settings.instantReplayEnabled === "boolean") {
    instantReplayEnabled = settings.instantReplayEnabled;
  }
  if (
    typeof settings.instantReplayWindowSeconds === "number" ||
    typeof settings.instantReplayWindowSeconds === "string"
  ) {
    instantReplayWindowSeconds = normalizeInstantReplayWindowSeconds(
      settings.instantReplayWindowSeconds,
      instantReplayWindowSeconds,
    );
  }
  // Only replace when the snapshot actually carries the field. Older session
  // blobs omit it; treating that as [] wiped a freshly added allowlist.
  if (Object.hasOwn(settings, "instantReplayAllowedDomains")) {
    instantReplayAllowedDomains = normalizeInstantReplayAllowedDomains(
      settings.instantReplayAllowedDomains,
    );
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
      role="progressbar"
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow="${Math.round(fillPercent)}"
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
  // Header Set/Clear sit next to the section label; hide while the form is open.
  zipPasswordSetBtn.classList.toggle("hidden", open);
  zipPasswordClearBtn.classList.toggle("hidden", open || !zipPasswordConfigured);
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
  zipPasswordClearBtn.disabled = !configured;
  // Header actions stay visible while summary is shown; hide while editing.
  zipPasswordSetBtn.classList.toggle("hidden", zipPasswordFormOpen);
  zipPasswordClearBtn.classList.toggle("hidden", zipPasswordFormOpen || !configured);
  // Do not auto-open the form; only close if it is not already open.
  if (!zipPasswordFormOpen) {
    zipPasswordForm.classList.add("hidden");
    zipPasswordSummary.classList.remove("hidden");
  }
}

function formatInstantReplayWindowValue(seconds: number): string {
  return `${seconds}s`;
}

function setInstantReplayWindowDisplay(seconds: number): void {
  const value = normalizeInstantReplayWindowSeconds(seconds, instantReplayWindowSeconds);
  if (instantReplayWindowInput) {
    instantReplayWindowInput.value = String(value);
    instantReplayWindowInput.setAttribute("aria-valuenow", String(value));
    instantReplayWindowInput.setAttribute("aria-valuetext", `${value} seconds`);
    const min = Number(instantReplayWindowInput.min) || INSTANT_REPLAY_WINDOW_SECONDS_MIN;
    const max = Number(instantReplayWindowInput.max) || INSTANT_REPLAY_WINDOW_SECONDS_MAX;
    const span = Math.max(1, max - min);
    const progress = ((value - min) / span) * 100;
    instantReplayWindowInput.style.setProperty(
      "--ir-window-progress",
      `${Math.min(100, Math.max(0, progress))}%`,
    );
  }
  if (instantReplayWindowValue) {
    instantReplayWindowValue.textContent = formatInstantReplayWindowValue(value);
  }
}

function isPopupDialogOpen(id: PopupDialogId): boolean {
  return popupDialogHost.isOpen(id);
}

function syncPopupDialogBodyLock(): void {
  document.body.classList.toggle("popup-dialog-open", popupDialogHost.anyOpen());
}

function applyPopupDialogDom(id: PopupDialogId, open: boolean): void {
  const entry = popupDialogEntries.get(id);
  if (!entry?.root) {
    return;
  }
  entry.root.classList.toggle("hidden", !open);
  entry.root.setAttribute("aria-hidden", open ? "false" : "true");
  if (entry.trigger) {
    entry.trigger.setAttribute("aria-expanded", open ? "true" : "false");
    entry.trigger.classList.toggle("is-open", open);
  }
}

/**
 * Single-open dialog host: opening one dialog closes every other open dialog
 * without an N-way hard-coded ladder.
 */
function setPopupDialogOpen(id: PopupDialogId, open: boolean): void {
  const entry = popupDialogEntries.get(id);
  if (!entry?.root) {
    return;
  }
  const wasOpen = popupDialogHost.isOpen(id);
  if (open === wasOpen) {
    return;
  }

  if (open) {
    const { closedIds } = popupDialogHost.markOpen(id);
    for (const otherId of closedIds) {
      applyPopupDialogDom(otherId, false);
    }
    applyPopupDialogDom(id, true);
    syncPopupDialogBodyLock();
    entry.onOpen?.();
    (entry.focusOnOpen ?? entry.trigger)?.focus();
    return;
  }

  popupDialogHost.markClose(id);
  applyPopupDialogDom(id, false);
  syncPopupDialogBodyLock();
  if (wasOpen) {
    entry.trigger?.focus();
  }
}

function setFeedbackDialogOpen(open: boolean): void {
  setPopupDialogOpen("feedback", open);
}

function setInstantReplaySettingsOpen(open: boolean): void {
  setPopupDialogOpen("instant-replay", open);
}

function setManageCloudsDialogOpen(open: boolean): void {
  setPopupDialogOpen("manage-clouds", open);
}

function setUploadHistoryDialogOpen(open: boolean): void {
  setPopupDialogOpen("upload-history", open);
}

function setSettingsDialogOpen(open: boolean): void {
  setPopupDialogOpen("settings", open);
}

function registerPopupDialogs(): void {
  popupDialogEntries.set("feedback", {
    root: feedbackDialog,
    trigger: feedbackToggleBtn,
    focusOnOpen: feedbackMessageInput ?? feedbackCloseBtn,
  });
  popupDialogEntries.set("instant-replay", {
    root: instantReplayDialog,
    trigger: instantReplaySettingsBtn,
    focusOnOpen: instantReplayWindowInput ?? instantReplaySettingsCloseBtn,
  });
  popupDialogEntries.set("manage-clouds", {
    root: manageCloudsDialog,
    trigger: manageStorageBtn,
    focusOnOpen: manageCloudsCloseBtn,
    onOpen: () => {
      void refreshManageCloudsAndRender();
    },
  });
  popupDialogEntries.set("upload-history", {
    root: uploadHistoryDialog,
    trigger: uploadHistoryPageBtn,
    focusOnOpen: uploadHistoryCloseBtn,
    onOpen: () => {
      renderPopupUploadHistory(currentUploadHistory, { animateLatestSuccess: false });
    },
  });
  popupDialogEntries.set("settings", {
    root: settingsDialog,
    trigger: settingsPageBtn,
    focusOnOpen: settingsCloseBtn,
    onOpen: () => {
      void settingsForm?.load();
    },
  });
}

function updateInstantReplayControls(options: { recordingActive?: boolean } = {}): void {
  const recordingActive =
    options.recordingActive ?? Boolean(latestPopupState?.recording?.isRecording);

  // Hide the settings panel while a full Record session owns the tab.
  if (recordingActive && isPopupDialogOpen("instant-replay")) {
    setInstantReplaySettingsOpen(false);
  }

  if (instantReplayControls) {
    instantReplayControls.setAttribute("aria-label", t("instantReplay.groupAria"));
  }

  if (instantReplayEnableBtn) {
    const enableBusy =
      recordingActive || instantReplayCaptureInFlight || instantReplayEnableSaveInFlight;
    instantReplayEnableBtn.disabled = enableBusy;
    instantReplayEnableBtn.classList.toggle("is-enabled", instantReplayEnabled);
    instantReplayEnableBtn.setAttribute("aria-pressed", instantReplayEnabled ? "true" : "false");
    instantReplayEnableBtn.setAttribute("title", t("actions.enableInstantReplayTitle"));
    const enableLabel = instantReplayEnableBtn.querySelector("span");
    if (enableLabel && !instantReplayEnableSaveInFlight) {
      enableLabel.textContent = instantReplayEnabled
        ? t("actions.enableInstantReplayOn")
        : t("actions.enableInstantReplay");
    }
  }

  if (instantReplayBtn) {
    const domainAllowed = tabUrlMatchesInstantReplayAllowlist(
      activeTabUrl,
      instantReplayAllowedDomains,
    );
    const blocked =
      recordingActive ||
      toggleActionInFlight ||
      instantReplayCaptureInFlight ||
      !instantReplayEnabled ||
      !domainAllowed ||
      Boolean(activeTabRecordingError);
    instantReplayBtn.disabled = blocked;
    if (activeTabRecordingError && !recordingActive) {
      instantReplayBtn.setAttribute("title", activeTabRecordingError);
    } else if (!instantReplayEnabled) {
      instantReplayBtn.setAttribute("title", t("instantReplay.disabledTitle"));
    } else if (!domainAllowed) {
      instantReplayBtn.setAttribute("title", t("instantReplay.domainNotAllowedTitle"));
    } else {
      instantReplayBtn.setAttribute("title", t("actions.captureInstantReplayTitle"));
    }
    const captureLabel = instantReplayBtn.querySelector("span");
    if (captureLabel && !instantReplayCaptureInFlight) {
      captureLabel.textContent = t("actions.captureInstantReplay");
    }
  }

  if (instantReplaySettingsBtn) {
    instantReplaySettingsBtn.disabled = recordingActive || instantReplayCaptureInFlight;
    instantReplaySettingsBtn.setAttribute("title", t("instantReplay.settingsTitle"));
    instantReplaySettingsBtn.setAttribute("aria-label", t("instantReplay.settingsAria"));
    const settingsLabel = instantReplaySettingsBtn.querySelector(".instant-replay-settings-label");
    if (settingsLabel) {
      settingsLabel.textContent = t("actions.instantReplaySettings");
    }
  }

  if (instantReplayPanel) {
    instantReplayPanel.setAttribute("aria-label", t("instantReplay.settingsAria"));
  }
  if (instantReplaySettingsCloseBtn) {
    instantReplaySettingsCloseBtn.setAttribute("title", t("dialog.close"));
    instantReplaySettingsCloseBtn.setAttribute("aria-label", t("dialog.close"));
  }

  if (instantReplayWindowInput && !instantReplayWindowSaveInFlight) {
    setInstantReplayWindowDisplay(instantReplayWindowSeconds);
    instantReplayWindowInput.disabled =
      recordingActive || !instantReplayEnabled || instantReplayCaptureInFlight;
  }

  renderInstantReplayDomainsList();
  void syncInstantReplayAddSiteButtonLabel(recordingActive);
}

function renderInstantReplayDomainsList(options: { flash?: boolean } = {}): void {
  if (!instantReplayDomainsList) {
    return;
  }
  const recordingActive = Boolean(latestPopupState?.recording?.isRecording);
  const removeDisabled =
    recordingActive ||
    !instantReplayEnabled ||
    instantReplayDomainSaveInFlight ||
    instantReplayCaptureInFlight;
  if (instantReplayAllowedDomains.length === 0) {
    instantReplayDomainsList.innerHTML = `<p class="instant-replay-domains-empty">${escapeHtml(
      t("instantReplay.domainsEmpty"),
    )}</p>`;
  } else {
    instantReplayDomainsList.innerHTML = instantReplayAllowedDomains
      .map((domain) => {
        const isNew = domain === instantReplayJustAddedDomain;
        const safeDomain = escapeHtml(domain);
        return `<span class="instant-replay-domain-chip${
          isNew ? " is-new" : ""
        }" role="listitem" data-domain="${safeDomain}" title="${safeDomain}">
          <span class="instant-replay-domain-chip-label">${safeDomain}</span>
          <button
            type="button"
            class="instant-replay-domain-remove"
            data-ir-domain-remove="${safeDomain}"
            aria-label="${escapeHtml(t("instantReplay.removeDomain", { domain }))}"
            title="${escapeHtml(t("instantReplay.removeDomain", { domain }))}"
            ${removeDisabled ? "disabled" : ""}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
              <path d="M6 6l12 12M18 6 6 18"/>
            </svg>
          </button>
        </span>`;
      })
      .join("");
  }
  if (options.flash) {
    instantReplayDomainsList.classList.remove("is-updated");
    // Restart CSS animation.
    void instantReplayDomainsList.offsetWidth;
    instantReplayDomainsList.classList.add("is-updated");
    window.setTimeout(() => {
      instantReplayDomainsList?.classList.remove("is-updated");
    }, 800);
  }
}

function setInstantReplayAddSiteButtonFeedback(mode: "idle" | "added" | "exists"): void {
  if (!instantReplayAddSiteBtn) {
    return;
  }
  if (instantReplayAddButtonFeedbackTimeout) {
    clearTimeout(instantReplayAddButtonFeedbackTimeout);
    instantReplayAddButtonFeedbackTimeout = null;
  }
  if (mode === "idle") {
    instantReplayAddSiteBtn.classList.remove("is-added");
    instantReplayAddSiteBtn.textContent = t("instantReplay.addThisSite");
    return;
  }
  instantReplayAddSiteBtn.classList.add("is-added");
  instantReplayAddSiteBtn.textContent =
    mode === "added" ? t("instantReplay.addThisSiteDone") : t("instantReplay.alreadyOnList");
  instantReplayAddButtonFeedbackTimeout = setTimeout(() => {
    instantReplayAddButtonFeedbackTimeout = null;
    instantReplayJustAddedDomain = null;
    setInstantReplayAddSiteButtonFeedback("idle");
    renderInstantReplayDomainsList();
  }, 2200);
}

async function syncInstantReplayAddSiteButtonLabel(recordingActive: boolean): Promise<void> {
  if (!instantReplayAddSiteBtn) {
    return;
  }
  // Don't clobber temporary "Added" / "Already added" feedback.
  if (instantReplayAddButtonFeedbackTimeout) {
    instantReplayAddSiteBtn.disabled =
      recordingActive ||
      !instantReplayEnabled ||
      instantReplayDomainSaveInFlight ||
      instantReplayCaptureInFlight;
    return;
  }
  instantReplayAddSiteBtn.disabled =
    recordingActive ||
    !instantReplayEnabled ||
    instantReplayDomainSaveInFlight ||
    instantReplayCaptureInFlight;
  instantReplayAddSiteBtn.classList.remove("is-added");
  instantReplayAddSiteBtn.textContent = t("instantReplay.addThisSite");
}

async function persistInstantReplayAllowedDomains(
  next: string[],
): Promise<{ ok: true; domains: string[] } | { ok: false; error: string }> {
  const normalized = normalizeInstantReplayAllowedDomains(next);
  const result = (await chrome.runtime.sendMessage({
    action: "UPDATE_SETTINGS",
    data: { instantReplayAllowedDomains: normalized },
  })) as MessageResponse & { settings?: PopupState["settings"] };

  if (!result?.ok || !result.settings) {
    return { ok: false, error: result?.error || t("instantReplay.saveFailed") };
  }

  let domains = normalizeInstantReplayAllowedDomains(
    result.settings.instantReplayAllowedDomains ?? normalized,
  );
  // Prefer the list we saved if the snapshot omitted/lagged the field.
  if (
    domains.length !== normalized.length ||
    normalized.some((domain) => !domains.includes(domain))
  ) {
    domains = normalized;
  }

  instantReplayAllowedDomains = domains;
  if (latestPopupState?.settings) {
    latestPopupState = {
      ...latestPopupState,
      settings: {
        ...latestPopupState.settings,
        instantReplayAllowedDomains: [...instantReplayAllowedDomains],
      },
    };
  }
  await hydrateInstantReplaySettingsFromLocal();
  // Keep the saved list if storage lag re-read an older value mid-flight.
  if (
    instantReplayAllowedDomains.length !== domains.length ||
    domains.some((domain) => !instantReplayAllowedDomains.includes(domain))
  ) {
    instantReplayAllowedDomains = domains;
  }
  return { ok: true, domains: instantReplayAllowedDomains };
}

async function addCurrentSiteToInstantReplayAllowlist(): Promise<void> {
  if (instantReplayDomainSaveInFlight) {
    return;
  }
  if (!instantReplayEnabled) {
    showToast(t("instantReplay.enableFirst"), 2800, { variant: "error" });
    return;
  }
  instantReplayDomainSaveInFlight = true;
  updateInstantReplayControls();
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const host = hostnameFromTabUrl(tab?.url);
    const pattern = normalizeInstantReplayDomainPattern(host);
    if (!pattern) {
      showToast(t("instantReplay.domainInvalid"), 3600, { variant: "error" });
      return;
    }
    if (instantReplayAllowedDomains.includes(pattern)) {
      instantReplayJustAddedDomain = pattern;
      renderInstantReplayDomainsList({ flash: true });
      setInstantReplayAddSiteButtonFeedback("exists");
      showToast(t("instantReplay.domainExists", { domain: pattern }), 2800, {
        variant: "info",
      });
      return;
    }
    const next = [...instantReplayAllowedDomains, pattern];
    const saved = await persistInstantReplayAllowedDomains(next);
    if (!saved.ok) {
      showToast(saved.error, 3600, { variant: "error" });
      return;
    }
    instantReplayJustAddedDomain = pattern;
    renderInstantReplayDomainsList({ flash: true });
    setInstantReplayAddSiteButtonFeedback("added");
    showToast(t("instantReplay.domainAdded", { domain: pattern }), 3200, {
      variant: "success",
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    showToast(detail || t("instantReplay.saveFailed"), 3600, { variant: "error" });
  } finally {
    instantReplayDomainSaveInFlight = false;
    updateInstantReplayControls({
      recordingActive: Boolean(latestPopupState?.recording?.isRecording),
    });
  }
}

async function removeDomainFromInstantReplayAllowlist(domain: string): Promise<void> {
  if (instantReplayDomainSaveInFlight) {
    return;
  }
  if (!instantReplayEnabled) {
    showToast(t("instantReplay.enableFirst"), 2800, { variant: "error" });
    return;
  }
  const pattern = normalizeInstantReplayDomainPattern(domain) || domain.trim().toLowerCase();
  if (!pattern || !instantReplayAllowedDomains.includes(pattern)) {
    // Already gone — just re-render from current state.
    renderInstantReplayDomainsList();
    return;
  }

  instantReplayDomainSaveInFlight = true;
  if (instantReplayJustAddedDomain === pattern) {
    instantReplayJustAddedDomain = null;
  }
  updateInstantReplayControls();
  try {
    const next = instantReplayAllowedDomains.filter((entry) => entry !== pattern);
    const saved = await persistInstantReplayAllowedDomains(next);
    if (!saved.ok) {
      showToast(saved.error, 3600, { variant: "error" });
      return;
    }
    renderInstantReplayDomainsList({ flash: true });
    showToast(t("instantReplay.domainRemoved", { domain: pattern }), 2800, {
      variant: "success",
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    showToast(detail || t("instantReplay.saveFailed"), 3600, { variant: "error" });
  } finally {
    instantReplayDomainSaveInFlight = false;
    updateInstantReplayControls({
      recordingActive: Boolean(latestPopupState?.recording?.isRecording),
    });
  }
}

async function saveInstantReplayEnabled(enabled: boolean): Promise<void> {
  if (instantReplayEnableSaveInFlight) {
    return;
  }
  instantReplayEnableSaveInFlight = true;
  if (instantReplayEnableBtn) {
    instantReplayEnableBtn.disabled = true;
  }
  try {
    const result = (await chrome.runtime.sendMessage({
      action: "UPDATE_SETTINGS",
      data: { instantReplayEnabled: enabled },
    })) as MessageResponse & { settings?: PopupState["settings"] };

    if (!result?.ok || !result.settings) {
      showToast(result?.error || t("instantReplay.saveFailed"), 3200, { variant: "error" });
      return;
    }

    instantReplayEnabled = Boolean(result.settings.instantReplayEnabled);
    if (latestPopupState?.settings) {
      latestPopupState = {
        ...latestPopupState,
        settings: {
          ...latestPopupState.settings,
          instantReplayEnabled,
        },
      };
    }
    showToast(
      instantReplayEnabled ? t("instantReplay.enabledSaved") : t("instantReplay.disabledSaved"),
      1400,
      { variant: "success" },
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    showToast(detail || t("instantReplay.saveFailed"), 3200, { variant: "error" });
  } finally {
    instantReplayEnableSaveInFlight = false;
    updateInstantReplayControls({
      recordingActive: Boolean(latestPopupState?.recording?.isRecording),
    });
  }
}

async function saveInstantReplayWindowSeconds(seconds: number): Promise<void> {
  if (!instantReplayWindowInput || instantReplayWindowSaveInFlight) {
    return;
  }
  const next = normalizeInstantReplayWindowSeconds(seconds, instantReplayWindowSeconds);
  instantReplayWindowSaveInFlight = true;
  instantReplayWindowInput.disabled = true;
  setInstantReplayWindowDisplay(next);
  try {
    const result = (await chrome.runtime.sendMessage({
      action: "UPDATE_SETTINGS",
      data: { instantReplayWindowSeconds: next },
    })) as MessageResponse & { settings?: PopupState["settings"] };

    if (!result?.ok || !result.settings) {
      setInstantReplayWindowDisplay(instantReplayWindowSeconds);
      showToast(result?.error || t("instantReplay.saveFailed"), 3200, { variant: "error" });
      return;
    }

    instantReplayWindowSeconds = normalizeInstantReplayWindowSeconds(
      result.settings.instantReplayWindowSeconds,
      next,
    );
    if (latestPopupState?.settings) {
      latestPopupState = {
        ...latestPopupState,
        settings: {
          ...latestPopupState.settings,
          instantReplayWindowSeconds,
        },
      };
    }
    setInstantReplayWindowDisplay(instantReplayWindowSeconds);
    showToast(t("instantReplay.windowSaved"), 1400, { variant: "success" });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    setInstantReplayWindowDisplay(instantReplayWindowSeconds);
    showToast(detail || t("instantReplay.saveFailed"), 3200, { variant: "error" });
  } finally {
    instantReplayWindowSaveInFlight = false;
    updateInstantReplayControls({
      recordingActive: Boolean(latestPopupState?.recording?.isRecording),
    });
  }
}

async function startRecordingSession(): Promise<void> {
  toggleActionInFlight = true;
  toggleBtn.disabled = true;
  if (instantReplayBtn) {
    instantReplayBtn.disabled = true;
  }
  errorMsg.classList.add("hidden");

  try {
    const currentState = await loadStateFromStorage();
    if (!getActiveStorageConnection(currentState).isConnected) {
      showError(t("storage.connectBeforeRecord"));
      return;
    }

    if (currentState?.recording?.isRecording) {
      return;
    }

    toggleActionMode = "start";
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
      updateInstantReplayControls();
    }
  }
}

async function captureInstantReplayNow(): Promise<void> {
  if (instantReplayCaptureInFlight) {
    return;
  }
  instantReplayCaptureInFlight = true;
  errorMsg.classList.add("hidden");
  updateInstantReplayControls();
  if (instantReplayBtn) {
    instantReplayBtn.setAttribute("aria-busy", "true");
    const label = instantReplayBtn.querySelector("span");
    if (label) {
      label.textContent = t("actions.capturingInstantReplay");
    }
  }

  try {
    const currentState = await loadStateFromStorage();
    if (!getActiveStorageConnection(currentState).isConnected) {
      showError(t("storage.connectBeforeRecord"));
      return;
    }
    if (!instantReplayEnabled) {
      setInstantReplaySettingsOpen(true);
      showError(t("instantReplay.disabledTitle"));
      return;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTabUrl = tab?.url || tab?.pendingUrl || null;
    const target = getRecordingTabTarget(tab);
    if (target.error) {
      activeTabRecordingError = target.error;
      showError(target.error);
      return;
    }
    if (!tabUrlMatchesInstantReplayAllowlist(activeTabUrl, instantReplayAllowedDomains)) {
      setInstantReplaySettingsOpen(true);
      showError(t("instantReplay.domainNotAllowedTitle"));
      return;
    }

    const result = (await chrome.runtime.sendMessage({
      action: "CAPTURE_INSTANT_REPLAY",
      tabId: tab.id,
    })) as MessageResponse;

    if (!result?.ok) {
      showError(result?.error || t("instantReplay.captureFailed"));
      return;
    }

    // Annotate still → save → upload. Open editor from the popup click so the
    // tab is not lost if the service-worker open raced with popup teardown.
    await openAnnotateEditorAfterCapture();
  } catch (error) {
    showError((error as Error).message || t("instantReplay.captureFailed"));
  } finally {
    instantReplayCaptureInFlight = false;
    if (instantReplayBtn) {
      instantReplayBtn.removeAttribute("aria-busy");
      const label = instantReplayBtn.querySelector("span");
      if (label) {
        label.textContent = t("actions.captureInstantReplay");
      }
    }
    updateInstantReplayControls({
      recordingActive: Boolean(latestPopupState?.recording?.isRecording),
    });
  }
}

/**
 * After CAPTURE_SCREENSHOT / CAPTURE_INSTANT_REPLAY, ensure the annotate tab
 * is open, then close the popup. The service worker usually opened it already;
 * if that tab was lost with popup lifecycle, open one from this click.
 */
async function openAnnotateEditorAfterCapture(): Promise<void> {
  const editorUrl = chrome.runtime.getURL("annotate/annotate.html");
  const OPENED_AT_KEY = "gn_tracing_annotate_opened_at";
  try {
    const stored = await chrome.storage.session.get(OPENED_AT_KEY);
    const openedAt = stored?.[OPENED_AT_KEY];
    const recentlyOpened = typeof openedAt === "number" && Date.now() - openedAt < 8_000;
    if (!recentlyOpened) {
      await chrome.tabs.create({ url: editorUrl, active: true });
    }
  } catch {
    try {
      await chrome.tabs.create({ url: editorUrl, active: true });
    } catch {
      // SW may still have opened the editor; closing the popup is fine either way.
    }
  }
  window.close();
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

function updateUploadHistorySummaries(): void {
  const count = currentUploadHistory.length;
  const latest = currentUploadHistory[0] || null;
  if (uploadHistoryEntrySummary) {
    uploadHistoryEntrySummary.textContent =
      count === 0
        ? t("history.entryEmpty")
        : t("history.entrySummary", {
            count: String(count),
            plural: count === 1 ? "" : "s",
            page: formatPageLabel(latest?.pageUrl),
          });
  }
  if (uploadHistoryDialogSummary) {
    uploadHistoryDialogSummary.textContent =
      count === 0
        ? t("history.summaryEmpty")
        : t("history.summaryCount", {
            count: String(count),
            plural: count === 1 ? "" : "s",
          });
  }
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
  // Full list lives in the history dialog.
  popupUploadHistoryList.innerHTML = renderUploadHistoryList(currentUploadHistory);
  updateUploadHistorySummaries();
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
    // Surface the full list when a new upload lands.
    setUploadHistoryDialogOpen(true);
  }
  if (latestUpload && animatingUploadHistoryIds.has(latestUpload.id)) {
    popupUploadHistoryList.querySelector(".history-item")?.classList.add("is-upload-success");
  }
}

function renderManageCloudsProviderList(): void {
  if (!popupProviderList) {
    return;
  }
  const providers: Array<"google-drive" | "dropbox"> = ["google-drive", "dropbox"];
  popupProviderList.innerHTML = "";
  for (const id of providers) {
    const connected = Boolean(connectedProviders.get(id));
    const busy = manageCloudsBusy.has(id);
    const error = manageCloudsErrors.get(id);
    const name = storageProviderDisplayName(id);

    const card = document.createElement("div");
    card.className = "popup-provider-card";
    card.dataset.provider = id;
    card.setAttribute("role", "listitem");

    const meta = document.createElement("div");
    meta.className = "meta";
    const nameEl = document.createElement("div");
    nameEl.className = "name";
    nameEl.textContent = name;
    const statusEl = document.createElement("div");
    statusEl.className = "status";
    if (busy) {
      statusEl.classList.add("is-busy");
      statusEl.innerHTML = `${buttonSpinnerHtml()}<span>${escapeHtml(t("storage.working"))}</span>`;
    } else if (error) {
      statusEl.classList.add("is-error");
      statusEl.textContent = error;
    } else if (connected) {
      statusEl.classList.add("is-connected");
      statusEl.textContent = t("storage.connected");
    } else {
      statusEl.textContent = t("storage.notConnectedStatus");
    }
    meta.append(nameEl, statusEl);

    const actions = document.createElement("div");
    actions.className = "actions";
    const actionBtn = document.createElement("button");
    actionBtn.type = "button";
    actionBtn.className = connected ? "btn btn-secondary btn-small" : "btn btn-start btn-small";
    actionBtn.disabled = busy;
    actionBtn.textContent = connected
      ? t("storage.disconnect")
      : t("storage.connectProvider", { name });
    actionBtn.addEventListener("click", () => {
      if (connected) {
        void disconnectCloudProvider(id);
      } else {
        void connectCloudProvider(id);
      }
    });
    actions.append(actionBtn);
    card.append(meta, actions);
    popupProviderList.append(card);
  }
}

async function refreshManageCloudsAndRender(): Promise<void> {
  await refreshAllProviderStatuses();
  renderManageCloudsProviderList();
}

async function connectCloudProvider(provider: "google-drive" | "dropbox"): Promise<void> {
  manageCloudsBusy.add(provider);
  manageCloudsErrors.delete(provider);
  renderManageCloudsProviderList();
  try {
    const result = (await chrome.runtime.sendMessage({
      action: "STORAGE_CONNECT",
      data: { provider },
    })) as MessageResponse;
    if (!result.ok) {
      throw new Error(
        result.error || t("storage.notConnected", { name: storageProviderDisplayName(provider) }),
      );
    }
    connectedProviders.set(provider, true);
    await chrome.runtime.sendMessage({
      action: "UPDATE_SETTINGS",
      data: { activeStorageProvider: provider },
    });
    await refreshPopupFromStorage();
    await refreshAllProviderStatuses();
    updateStorageUI(true, provider);
  } catch (error) {
    manageCloudsErrors.set(provider, error instanceof Error ? error.message : String(error));
  } finally {
    manageCloudsBusy.delete(provider);
    renderManageCloudsProviderList();
  }
}

async function disconnectCloudProvider(provider: "google-drive" | "dropbox"): Promise<void> {
  manageCloudsBusy.add(provider);
  manageCloudsErrors.delete(provider);
  renderManageCloudsProviderList();
  try {
    const result = (await chrome.runtime.sendMessage({
      action: "STORAGE_DISCONNECT",
      data: { provider },
    })) as MessageResponse;
    if (!result.ok) {
      throw new Error(result.error || t("storage.switchFailed"));
    }
    connectedProviders.set(provider, false);
    await refreshPopupFromStorage();
    await refreshAllProviderStatuses();
    const next = listConnectedProviderIds()[0] || provider;
    updateStorageUI(Boolean(listConnectedProviderIds().length), next);
  } catch (error) {
    manageCloudsErrors.set(provider, error instanceof Error ? error.message : String(error));
  } finally {
    manageCloudsBusy.delete(provider);
    renderManageCloudsProviderList();
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

function formatStorageFolderLabel(settings?: PopupState["settings"] | null): string {
  const folder = settings?.folderInput?.trim();
  if (folder && folder !== "/") {
    return folder;
  }
  if (settings?.folderId) {
    return settings.folderId;
  }
  return "/gn-tracing";
}

function setStorageEditorOpen(open: boolean): void {
  const wasOpen = storageEditorOpen;
  storageEditorOpen = open;
  const anyConnected = listConnectedProviderIds().length > 0;
  // Summary only when connected and not editing.
  storageSummary?.classList.toggle("hidden", open || !anyConnected);
  storageEditor?.classList.toggle("hidden", !open);
  // While editing, keep Manage in the header but hide Edit (Done/Cancel cover it).
  storageEditBtn?.classList.toggle("hidden", open || !anyConnected);
  if (open && !wasOpen && storageFolderInput && !storageFolderInput.disabled) {
    // Focus folder after layout paints so the field is visible.
    window.setTimeout(() => storageFolderInput.focus(), 0);
  }
}

function updateStorageFolderUi(settings?: PopupState["settings"] | null): void {
  if (!storageFolderInput) {
    return;
  }
  const resolved = settings || latestPopupState?.settings || null;
  const provider = normalizePopupStorageProvider(
    resolved?.activeStorageProvider || storageProviderSelect?.value || "google-drive",
  );
  const folderInput = resolved?.folderInput ?? storageFolderInput.value;
  const folderId = resolved?.folderId ?? null;
  const anyConnected = listConnectedProviderIds().length > 0;

  // Avoid clobbering in-progress typing while the user is editing the field.
  if (document.activeElement !== storageFolderInput || !storageEditorOpen) {
    storageFolderInput.value = folderInput || "/gn-tracing";
  }
  storageFolderInput.disabled = !anyConnected;
  storageFolderInput.placeholder =
    provider === "dropbox"
      ? t("storage.folderPlaceholderDropbox")
      : t("storage.folderPlaceholderDrive");

  if (!storageFolderHint) {
    return;
  }
  if (provider === "dropbox") {
    storageFolderHint.textContent =
      folderInput && folderInput !== "/"
        ? t("storage.folderHintPath", { value: folderInput })
        : t("storage.folderHintDropbox");
    return;
  }
  if (folderId) {
    storageFolderHint.textContent = t("storage.folderHintId", { value: folderId });
    return;
  }
  storageFolderHint.textContent =
    folderInput && folderInput !== "/"
      ? t("storage.folderHintPath", { value: folderInput })
      : t("storage.folderHintRoot");
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

  if (manageStorageBtn) {
    manageStorageBtn.textContent = anyConnected
      ? t("storage.manageClouds")
      : t("storage.connectClouds");
    manageStorageBtn.classList.toggle("btn-start", !anyConnected);
    manageStorageBtn.classList.toggle("btn-secondary", anyConnected);
  }

  // Summary line only when connected and not in the editor.
  if (storageSummaryLine) {
    if (selectedConnected && selected) {
      storageSummaryLine.textContent = t("storage.summaryConnected", {
        name: storageProviderDisplayName(selected),
        folder: formatStorageFolderLabel(latestPopupState?.settings),
      });
    } else {
      storageSummaryLine.textContent = "";
    }
  }
  // Edit only when connected; hide summary entirely when disconnected.
  storageEditBtn?.classList.toggle("hidden", !anyConnected);
  storageEditBtn?.classList.toggle("btn-secondary", true);
  storageSummary?.classList.toggle("hidden", !anyConnected || storageEditorOpen);

  // Stay collapsed when disconnected; force summary mode.
  if (!anyConnected && storageEditorOpen) {
    setStorageEditorOpen(false);
    storageEditorSnapshot = null;
  } else {
    setStorageEditorOpen(storageEditorOpen);
  }

  updateStorageFolderUi(latestPopupState?.settings);
}

async function saveStorageFolder(options: { silent?: boolean } = {}): Promise<void> {
  if (!storageFolderInput || storageFolderInput.disabled) {
    return;
  }
  const nextFolder = storageFolderInput.value.trim() === "/" ? "" : storageFolderInput.value.trim();
  const currentFolder = latestPopupState?.settings?.folderInput ?? "";
  if (nextFolder === currentFolder || (nextFolder === "" && currentFolder === "/")) {
    updateStorageFolderUi(latestPopupState?.settings);
    return;
  }

  storageFolderInput.disabled = true;
  try {
    const result = (await chrome.runtime.sendMessage({
      action: "UPDATE_SETTINGS",
      data: { folderInput: nextFolder },
    })) as MessageResponse & { settings?: PopupState["settings"] };
    if (!result.ok || !result.settings) {
      if (!options.silent) {
        showToast(result.error || t("storage.folderSaveFailed"), 3200, { variant: "error" });
      }
      updateStorageFolderUi(latestPopupState?.settings);
      return;
    }
    if (latestPopupState) {
      latestPopupState = {
        ...latestPopupState,
        settings: {
          ...latestPopupState.settings,
          ...result.settings,
        },
      };
    }
    updateStorageFolderUi(result.settings);
    if (!options.silent) {
      showToast(t("storage.folderSaved"), 1600, { variant: "success" });
    }
  } catch (error) {
    if (!options.silent) {
      const detail = error instanceof Error ? error.message : String(error);
      showToast(detail || t("storage.folderSaveFailed"), 3200, { variant: "error" });
    }
    updateStorageFolderUi(latestPopupState?.settings);
  } finally {
    storageFolderInput.disabled = listConnectedProviderIds().length === 0;
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

function openManageCloudsDialog(): void {
  setManageCloudsDialogOpen(true);
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
  return buttonSpinnerHtml();
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
  activeTabRecordingCheckInFlight = true;
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
    activeTabUrl = tab?.url || tab?.pendingUrl || null;
    activeTabRecordingError = getRecordingTabTarget(tab).error;
  } catch (error) {
    if (checkId !== activeTabRecordingCheckId) {
      return;
    }
    activeTabUrl = null;
    activeTabRecordingError = (error as Error).message || t("messages.cannotInspectTab");
  } finally {
    if (checkId === activeTabRecordingCheckId) {
      activeTabRecordingCheckInFlight = false;
    }
  }

  if (getActiveStorageConnection(latestPopupState).isConnected) {
    updateRecordingUI(latestPopupState?.recording ?? null);
  } else {
    // Still refresh IR enablement from the resolved active-tab URL.
    updateInstantReplayControls({
      recordingActive: Boolean(latestPopupState?.recording?.isRecording),
    });
  }
}

function updateRecordingUI(recording: RecordingStatus | null): void {
  if (recording?.isRecording) {
    updateInstantReplayControls({ recordingActive: true });

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

  updateInstantReplayControls({ recordingActive: false });
  const checkingTab = activeTabRecordingCheckInFlight;
  if (checkingTab) {
    setButtonLabel(toggleBtn, getLoadingIcon(), t("actions.startRecording"));
    toggleBtn.setAttribute("aria-busy", "true");
  } else {
    setButtonLabel(toggleBtn, getStartRecordingIcon(), t("actions.startRecording"));
    toggleBtn.removeAttribute("aria-busy");
  }
  toggleBtn.className = checkingTab ? "btn btn-start is-loading" : "btn btn-start";
  recordingActions.classList.remove("is-recording");
  removeRecordingBtn.classList.add("hidden");
  removeRecordingBtn.disabled = false;
  drawingSection.classList.add("hidden");
  setDrawButtonActive(false);
  statusBar.classList.add("hidden");
  stats.classList.add("hidden");
  const unavailableReason = checkingTab ? null : activeTabRecordingError;
  toggleBtn.disabled = toggleActionInFlight || checkingTab || Boolean(unavailableReason);
  recordingActions.classList.toggle("has-unavailable-reason", Boolean(unavailableReason));
  recordingUnavailableMsg.classList.toggle("hidden", !unavailableReason);
  recordingUnavailableMsg.textContent = unavailableReason || "";
  if (unavailableReason) {
    toggleBtn.setAttribute("title", unavailableReason);
  } else if (checkingTab) {
    toggleBtn.setAttribute("title", t("messages.checkingTab"));
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
  applyInstantReplaySettingsFromSnapshot(state.settings);
  updateInstantReplayControls({
    recordingActive: Boolean(state.recording?.isRecording),
  });
  // Keep folder field in sync when settings arrive from the service worker.
  updateStorageFolderUi(state.settings);
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

function openSettingsDialog(): void {
  setSettingsDialogOpen(!isPopupDialogOpen("settings"));
}

toggleBtn.addEventListener("click", async () => {
  errorMsg.classList.add("hidden");

  try {
    const currentState = await loadStateFromStorage();
    if (!getActiveStorageConnection(currentState).isConnected) {
      showError(t("storage.connectBeforeRecord"));
      return;
    }

    if (currentState?.recording?.isRecording) {
      toggleActionInFlight = true;
      toggleBtn.disabled = true;
      if (instantReplayBtn) {
        instantReplayBtn.disabled = true;
      }
      toggleActionMode = "stop";
      renderStopAndUploadLoading(currentState.recording);
      const result = (await chrome.runtime.sendMessage({
        action: "STOP_RECORDING",
      })) as MessageResponse;
      if (!result.ok) {
        showError(result.error || t("messages.stopFailed"));
      }
      return;
    }

    await startRecordingSession();
  } catch (error) {
    showError((error as Error).message);
  } finally {
    if (toggleActionMode === "stop") {
      toggleActionInFlight = false;
      toggleActionMode = null;
      const state = await loadStateFromStorage();
      if (state) {
        handleStateUpdate(state);
      } else {
        toggleBtn.removeAttribute("aria-busy");
        toggleBtn.disabled = false;
        updateInstantReplayControls();
      }
    }
  }
});

instantReplayBtn?.addEventListener("click", () => {
  void captureInstantReplayNow();
});

instantReplaySettingsBtn?.addEventListener("click", (event) => {
  event.stopPropagation();
  setInstantReplaySettingsOpen(!isPopupDialogOpen("instant-replay"));
});

instantReplaySettingsCloseBtn?.addEventListener("click", () => {
  setInstantReplaySettingsOpen(false);
});

manageCloudsCloseBtn?.addEventListener("click", () => {
  setManageCloudsDialogOpen(false);
});

uploadHistoryCloseBtn?.addEventListener("click", () => {
  setUploadHistoryDialogOpen(false);
});

function wirePopupDialogDismiss(root: HTMLElement | null, close: () => void): void {
  root?.querySelectorAll("[data-popup-dialog-dismiss]").forEach((el) => {
    el.addEventListener("click", () => {
      close();
    });
  });
}

wirePopupDialogDismiss(feedbackDialog, () => setFeedbackDialogOpen(false));
wirePopupDialogDismiss(instantReplayDialog, () => setInstantReplaySettingsOpen(false));
wirePopupDialogDismiss(manageCloudsDialog, () => setManageCloudsDialogOpen(false));
wirePopupDialogDismiss(uploadHistoryDialog, () => setUploadHistoryDialogOpen(false));
wirePopupDialogDismiss(settingsDialog, () => setSettingsDialogOpen(false));
feedbackCloseBtn?.addEventListener("click", () => {
  setFeedbackDialogOpen(false);
});
settingsCloseBtn?.addEventListener("click", () => {
  setSettingsDialogOpen(false);
});

// Keep clicks inside dialog panels from reaching the backdrop.
for (const panel of [feedbackPanel, instantReplayPanel, manageCloudsPanel, uploadHistoryPanel]) {
  panel?.addEventListener("click", (event) => {
    event.stopPropagation();
  });
}

instantReplayEnableBtn?.addEventListener("click", () => {
  void saveInstantReplayEnabled(!instantReplayEnabled);
});

instantReplayAddSiteBtn?.addEventListener("click", () => {
  void addCurrentSiteToInstantReplayAllowlist();
});

instantReplayDomainsList?.addEventListener("click", (event) => {
  const target = event.target as HTMLElement | null;
  const removeBtn = target?.closest<HTMLButtonElement>("[data-ir-domain-remove]");
  if (!removeBtn || removeBtn.disabled) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  const domain = removeBtn.getAttribute("data-ir-domain-remove") || "";
  if (!domain) {
    return;
  }
  void removeDomainFromInstantReplayAllowlist(domain);
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

/**
 * Screenshot reports open the annotate editor, then the popup closes so it
 * does not sit behind the focused editor tab.
 */
screenshotBtn.addEventListener("click", async () => {
  screenshotBtn.disabled = true;
  errorMsg.classList.add("hidden");

  try {
    const result = (await chrome.runtime.sendMessage({
      action: "CAPTURE_SCREENSHOT",
    })) as MessageResponse;

    if (!result?.ok) {
      showError(result?.error || t("messages.screenshotFailed"));
      return;
    }
    await openAnnotateEditorAfterCapture();
  } catch (error) {
    showError((error as Error).message);
  } finally {
    screenshotBtn.disabled = false;
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

settingsPageBtn.addEventListener("click", openSettingsDialog);

storageProviderSelect?.addEventListener("change", async () => {
  const raw = storageProviderSelect.value;
  if (!raw) {
    return;
  }
  const provider = normalizePopupStorageProvider(raw);
  if (!connectedProviders.get(provider)) {
    showError(t("storage.connectCloudFirst"));
    openManageCloudsDialog();
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
  setManageCloudsDialogOpen(!isPopupDialogOpen("manage-clouds"));
});

storageEditBtn?.addEventListener("click", () => {
  storageEditorSnapshot = {
    provider:
      storageProviderSelect?.value ||
      latestPopupState?.settings?.activeStorageProvider ||
      "google-drive",
    folderInput: latestPopupState?.settings?.folderInput ?? storageFolderInput?.value ?? "",
  };
  setStorageEditorOpen(true);
  updateStorageFolderUi(latestPopupState?.settings);
});

storageEditorDoneBtn?.addEventListener("click", async () => {
  await saveStorageFolder();
  storageEditorSnapshot = null;
  setStorageEditorOpen(false);
  updateStorageUI(
    Boolean(listConnectedProviderIds().length),
    storageProviderSelect?.value || latestPopupState?.settings?.activeStorageProvider,
  );
});

storageEditorCancelBtn?.addEventListener("click", async () => {
  // Revert provider if user changed it while editing.
  const snap = storageEditorSnapshot;
  storageEditorSnapshot = null;
  if (
    snap?.provider &&
    storageProviderSelect &&
    snap.provider !== storageProviderSelect.value &&
    connectedProviders.get(snap.provider)
  ) {
    try {
      await setActiveStorageProvider(snap.provider);
    } catch {
      // Fall through to restore folder from latest state.
    }
  }
  if (storageFolderInput) {
    storageFolderInput.value =
      snap?.folderInput || latestPopupState?.settings?.folderInput || "/gn-tracing";
  }
  updateStorageFolderUi(latestPopupState?.settings);
  setStorageEditorOpen(false);
  updateStorageUI(
    Boolean(listConnectedProviderIds().length),
    storageProviderSelect?.value || latestPopupState?.settings?.activeStorageProvider,
  );
});

storageFolderInput?.addEventListener("blur", () => {
  if (storageEditorOpen) {
    void saveStorageFolder({ silent: true });
  }
});

storageFolderInput?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void (async () => {
      await saveStorageFolder();
      storageEditorSnapshot = null;
      setStorageEditorOpen(false);
      updateStorageUI(
        Boolean(listConnectedProviderIds().length),
        storageProviderSelect?.value || latestPopupState?.settings?.activeStorageProvider,
      );
    })();
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
  if (event.key !== "Escape") {
    return;
  }
  if (!popupDialogHost.anyOpen()) {
    hideToast();
    return;
  }
  event.preventDefault();
  // Close any open dialog via the host snapshot (single-open policy).
  const openIds = popupDialogHost.listOpen();
  for (const id of openIds) {
    setPopupDialogOpen(id, false);
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
  setUploadHistoryDialogOpen(!isPopupDialogOpen("upload-history"));
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

instantReplayWindowInput?.addEventListener("input", () => {
  setInstantReplayWindowDisplay(Number(instantReplayWindowInput.value));
});

instantReplayWindowInput?.addEventListener("change", () => {
  void saveInstantReplayWindowSeconds(Number(instantReplayWindowInput.value));
});

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

  // Prefer durable local settings for IR allowlist before session paint — session
  // can lag after page reload / service-worker restart.
  await hydrateInstantReplaySettingsFromLocal();

  const initialState = await loadStateFromStorage();
  if (initialState) {
    handleStateUpdate(initialState);
  } else if (mirrored.isConnected === null) {
    renderSessions([]);
    renderPopupUploadHistory([], { animateLatestSuccess: false });
  }
  // Re-apply local IR fields after session paint so a stale session blob cannot
  // wipe an allowlist that was just persisted to local storage.
  await hydrateInstantReplaySettingsFromLocal();
  updateInstantReplayControls({
    recordingActive: Boolean(latestPopupState?.recording?.isRecording),
  });

  try {
    const settingsResult = (await chrome.runtime.sendMessage({
      action: "GET_SETTINGS",
    })) as MessageResponse & {
      settings?: PopupState["settings"];
      uploadHistory?: UploadHistoryEntry[];
    };
    if (settingsResult.ok && settingsResult.settings) {
      applyInstantReplaySettingsFromSnapshot(settingsResult.settings);
      updateInstantReplayControls({
        recordingActive: Boolean(latestPopupState?.recording?.isRecording),
      });
    }
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

feedbackToggleBtn.addEventListener("click", (event) => {
  event.stopPropagation();
  setFeedbackDialogOpen(!isPopupDialogOpen("feedback"));
});

feedbackCancelBtn.addEventListener("click", () => {
  setFeedbackDialogOpen(false);
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
  if (feedbackCloseBtn) {
    feedbackCloseBtn.disabled = true;
  }
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
    setFeedbackDialogOpen(false);
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
    if (feedbackCloseBtn) {
      feedbackCloseBtn.disabled = false;
    }
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

registerPopupDialogs();
attachSectionInfoButtons();

if (settingsFormRoot) {
  settingsForm = attachSettingsForm({
    root: settingsFormRoot,
    infoPopover: settingInfoPopover,
    getLanguage: () => currentLanguage,
    t,
    showMessage: (message, success = false) => {
      showToast(message, success ? 2200 : 4200, {
        variant: success ? "success" : "error",
      });
    },
  });
}

currentLanguage = attachLanguageSwitch({
  onChange: (language) => {
    currentLanguage = language;
    applyTranslations();
  },
});
applyTranslations();

void initPopup();
