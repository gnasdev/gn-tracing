/**
 * Renders and manages the full upload history page.
 */

import { attachPageNav } from "../shared/page-nav";
import { attachThemeToggle } from "../shared/theme";
import { attachLanguageSwitch, type UiLanguage } from "../shared/ui-language";
import {
  handleUploadHistoryAction,
  renderUploadHistoryList,
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
const historyCount = document.getElementById("history-count")!;
const errorMsg = document.getElementById("error-msg")!;

type HistoryLanguage = UiLanguage;

const TRANSLATIONS: Record<HistoryLanguage, Record<string, string>> = {
  en: {
    "topbar.pageTitle": "Upload History",
    "nav.settings": "Settings",
    "nav.history": "Upload History",
    "nav.connect": "Connect",
    "page.title": "Upload History",
    "page.lead":
      "Review previous uploads, jump back into a replay, copy a shareable link, or clean up old items.",
    "stats.savedUploads": "Saved Uploads",
    "panel.recentTitle": "Recent Uploads",
    "summary.empty": "Browse your recent uploads here once recordings are uploaded.",
    "summary.count": "{count} upload{plural} saved locally.",
    "messages.loadFailed": "Failed to load upload history",
    "messages.copySuccess": "Replay link copied.",
    "messages.copyFailed": "Failed to copy replay link",
    "messages.deleteFailed": "Failed to delete history item",
    "document.title": "GN Tracing Upload History",
  },
  vi: {
    "topbar.pageTitle": "Lịch sử upload",
    "nav.settings": "Cài đặt",
    "nav.history": "Lịch sử upload",
    "nav.connect": "Kết nối",
    "page.title": "Lịch sử upload",
    "page.lead":
      "Xem lại các upload trước, mở lại replay, sao chép link chia sẻ, hoặc dọn các mục cũ.",
    "stats.savedUploads": "Upload đã lưu",
    "panel.recentTitle": "Upload gần đây",
    "summary.empty": "Các bản ghi sau khi upload sẽ hiện tại đây.",
    "summary.count": "{count} upload được lưu cục bộ.",
    "messages.loadFailed": "Không tải được lịch sử upload",
    "messages.copySuccess": "Đã sao chép link replay.",
    "messages.copyFailed": "Không sao chép được link replay",
    "messages.deleteFailed": "Không xóa được mục lịch sử",
    "document.title": "Lịch sử upload GN Tracing",
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
  historyCount.textContent = String(currentHistory.length);

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
currentLanguage = attachLanguageSwitch({
  onChange: (language) => {
    currentLanguage = language;
    applyTranslations();
  },
});
applyTranslations();
void refreshHistory();

attachThemeToggle("theme-toggle-btn", "theme-toggle-icon");
