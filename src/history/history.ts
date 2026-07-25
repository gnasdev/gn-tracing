/**
 * Renders and manages the full upload history page.
 */

import { attachFeedbackPopover, type FeedbackUiController } from "../shared/feedback-ui";
import { attachPageNav } from "../shared/page-nav";
import { attachThemeToggle, type ThemeToggleController } from "../shared/theme";
import { attachLanguageSwitch, type UiLanguage } from "../shared/ui-language";
import {
  handleUploadHistoryAction,
  renderUploadHistoryList,
  setUploadHistoryUiLabels,
  sortUploadHistoryNewestFirst,
} from "../shared/upload-history-ui";
import type { MessageResponse, UploadHistoryEntry, UploadSettings } from "../types/messages";

/**
 * Full upload-history page controller.
 *
 * The popup shows only the latest upload, while this page renders the complete
 * locally stored history and delegates replay/copy/folder/delete actions through
 * the same shared renderer used by the popup.
 */
const uploadHistoryList = document.getElementById("upload-history-list")!;
const historySummary = document.getElementById("history-summary")!;
const errorMsg = document.getElementById("error-msg")!;

type HistoryLanguage = UiLanguage;

const TRANSLATIONS: Record<HistoryLanguage, Record<string, string>> = {
  en: {
    "topbar.pageTitle": "Upload History",
    "nav.settings": "Settings",
    "nav.history": "Upload History",
    "nav.connect": "Manage clouds",
    "theme.system": "System",
    "theme.light": "Light",
    "theme.dark": "Dark",
    "theme.aria": "Theme: {label}",
    "theme.titleSystem": "Theme: {label} (follows OS). Click to cycle System → Light → Dark.",
    "theme.titleFixed": "Theme: {label}. Click to cycle System → Light → Dark.",
    "feedback.button": "Feedback",
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
    "feedback.viewIssue": "View issue",
    "page.title": "Upload History",
    "page.lead":
      "Review previous uploads, jump back into a replay, copy a shareable link, or clean up old items.",
    "panel.recentTitle": "Recent Uploads",
    "summary.empty": "Browse your recent uploads here once recordings are uploaded.",
    "summary.count": "{count} upload{plural} saved locally.",
    "messages.loadFailed": "Failed to load upload history",
    "messages.copySuccess": "Replay link copied.",
    "messages.copyFailed": "Failed to copy replay link",
    "messages.deleteFailed": "Failed to delete history item",
    "document.title": "GN Tracing Upload History",
    "history.empty": "No uploads yet.",
    "history.duration": "Duration: {time}",
    "history.replay": "Replay",
    "history.copyLink": "Copy link",
    "history.openRemote": "Open remote",
    "history.delete": "Delete",
    "history.unknownTime": "Unknown time",
    "history.unknownPage": "Unknown page",
  },
  vi: {
    "topbar.pageTitle": "Lịch sử upload",
    "nav.settings": "Cài đặt",
    "nav.history": "Lịch sử upload",
    "nav.connect": "Quản lý cloud",
    "theme.system": "Hệ thống",
    "theme.light": "Sáng",
    "theme.dark": "Tối",
    "theme.aria": "Giao diện: {label}",
    "theme.titleSystem": "Giao diện: {label} (theo OS). Bấm để chuyển Hệ thống → Sáng → Tối.",
    "theme.titleFixed": "Giao diện: {label}. Bấm để chuyển Hệ thống → Sáng → Tối.",
    "feedback.button": "Góp ý",
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
    "feedback.viewIssue": "Xem issue",
    "page.title": "Lịch sử upload",
    "page.lead":
      "Xem lại các upload trước, mở lại replay, sao chép link chia sẻ, hoặc dọn các mục cũ.",
    "panel.recentTitle": "Upload gần đây",
    "summary.empty": "Các bản ghi sau khi upload sẽ hiện tại đây.",
    "summary.count": "{count} upload được lưu cục bộ.",
    "messages.loadFailed": "Không tải được lịch sử upload",
    "messages.copySuccess": "Đã sao chép link replay.",
    "messages.copyFailed": "Không sao chép được link replay",
    "messages.deleteFailed": "Không xóa được mục lịch sử",
    "document.title": "Lịch sử upload GN Tracing",
    "history.empty": "Chưa có upload nào.",
    "history.duration": "Thời lượng: {time}",
    "history.replay": "Replay",
    "history.copyLink": "Sao chép link",
    "history.openRemote": "Mở remote",
    "history.delete": "Xóa",
    "history.unknownTime": "Thời gian không rõ",
    "history.unknownPage": "Trang không rõ",
  },
};

let currentHistory: UploadHistoryEntry[] = [];
let currentLanguage: HistoryLanguage = "en";

function t(key: string, replacements: Record<string, string> = {}): string {
  const template = TRANSLATIONS[currentLanguage][key] || TRANSLATIONS.en[key] || key;
  return Object.entries(replacements).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, value),
    template,
  );
}

function applyTranslations(): void {
  document.documentElement.lang = currentLanguage;
  document.title = t("document.title");

  setUploadHistoryUiLabels({
    empty: t("history.empty"),
    duration: t("history.duration"),
    replay: t("history.replay"),
    copyLink: t("history.copyLink"),
    openRemote: t("history.openRemote"),
    delete: t("history.delete"),
    unknownTime: t("history.unknownTime"),
    unknownPage: t("history.unknownPage"),
  });

  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((element) => {
    // Dynamic summary is owned by renderHistory(); do not stomp it from static keys.
    if (element.id === "history-summary") {
      return;
    }
    element.textContent = t(element.dataset.i18n || "");
  });

  renderHistory(currentHistory);
}

function showError(message: string): void {
  errorMsg.textContent = message;
  errorMsg.className = "";
  errorMsg.classList.remove("hidden");
  setTimeout(() => errorMsg.classList.add("hidden"), 5000);
}

function showSuccess(message: string): void {
  errorMsg.textContent = message;
  errorMsg.className = "success-msg";
  errorMsg.classList.remove("hidden");
  setTimeout(() => errorMsg.classList.add("hidden"), 2000);
}

function openExternalUrl(url: string): void {
  chrome.tabs.create({ url });
}

function renderHistory(history: UploadHistoryEntry[]): void {
  currentHistory = sortUploadHistoryNewestFirst(history);
  uploadHistoryList.innerHTML = renderUploadHistoryList(currentHistory);

  if (currentHistory.length === 0) {
    historySummary.textContent = t("summary.empty");
    return;
  }

  historySummary.textContent = t("summary.count", {
    count: String(currentHistory.length),
    plural: currentHistory.length === 1 ? "" : "s",
  });
}

async function refreshHistory(): Promise<void> {
  try {
    const result = (await chrome.runtime.sendMessage({
      action: "GET_SETTINGS",
    })) as MessageResponse & {
      settings?: UploadSettings;
      uploadHistory?: UploadHistoryEntry[];
    };

    if (!result.ok) {
      showError(result.error || t("messages.loadFailed"));
      return;
    }

    renderHistory(Array.isArray(result.uploadHistory) ? result.uploadHistory : []);
  } catch (error) {
    showError((error as Error).message);
  }
}

uploadHistoryList.addEventListener("click", async (event) => {
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
      const previousHistory = currentHistory;
      renderHistory(currentHistory.filter((entry) => entry.id !== historyEntryId));
      button.disabled = true;
      try {
        const result = (await chrome.runtime.sendMessage({
          action: "DELETE_UPLOAD_HISTORY_ENTRY",
          data: { historyEntryId },
        })) as MessageResponse & { uploadHistory?: UploadHistoryEntry[] };

        if (!result.ok) {
          renderHistory(previousHistory);
          showError(result.error || t("messages.deleteFailed"));
          button.disabled = false;
          return;
        }

        // Rerender from the service worker response so the page reflects the
        // persisted local history state after deletion.
        if (Array.isArray(result.uploadHistory)) {
          renderHistory(result.uploadHistory);
        } else {
          await refreshHistory();
        }
      } catch (error) {
        renderHistory(previousHistory);
        showError((error as Error).message);
        button.disabled = false;
      }
    },
  });

  if (!handled) {
    errorMsg.classList.add("hidden");
  }
});

attachPageNav({ current: "history" });

const feedbackMount = document.getElementById("feedback-mount");
let feedbackUi: FeedbackUiController | null = null;
if (feedbackMount) {
  feedbackUi = attachFeedbackPopover({
    mount: feedbackMount,
    getLabels: () => ({
      button: t("feedback.button"),
      sectionAria: t("feedback.sectionAria"),
      label: t("feedback.label"),
      placeholder: t("feedback.placeholder"),
      hint: t("feedback.hint"),
      submit: t("feedback.submit"),
      cancel: t("feedback.cancel"),
      sending: t("feedback.sending"),
      success: t("feedback.success"),
      failed: t("feedback.failed"),
      viewIssue: t("feedback.viewIssue"),
    }),
  });
}

const themeToggleUi: ThemeToggleController | null = attachThemeToggle(
  "theme-toggle-btn",
  "theme-toggle-icon",
  {
    getLabels: () => ({
      system: t("theme.system"),
      light: t("theme.light"),
      dark: t("theme.dark"),
      aria: t("theme.aria"),
      titleSystem: t("theme.titleSystem"),
      titleFixed: t("theme.titleFixed"),
    }),
  },
);

currentLanguage = attachLanguageSwitch({
  onChange: (language) => {
    currentLanguage = language;
    applyTranslations();
    feedbackUi?.refreshLabels();
    themeToggleUi?.refreshLabels();
  },
});
applyTranslations();
feedbackUi?.refreshLabels();
themeToggleUi?.refreshLabels();
void refreshHistory();
