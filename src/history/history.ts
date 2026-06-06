/**
 * Renders and manages the full upload history page.
 */

import { attachThemeToggle } from "../shared/theme";
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

let currentHistory: UploadHistoryEntry[] = [];

function showError(message: string): void {
  errorMsg.textContent = message;
  errorMsg.className = "";
  errorMsg.classList.remove("hidden");
  setTimeout(() => errorMsg.classList.add("hidden"), 5000);
}

function showSuccess(message: string): void {
  errorMsg.textContent = message;
  errorMsg.className = "success-msg";
  setTimeout(() => (errorMsg.className = "hidden"), 2000);
}

function openExternalUrl(url: string): void {
  chrome.tabs.create({ url });
}

function renderHistory(history: UploadHistoryEntry[]): void {
  currentHistory = sortUploadHistoryNewestFirst(history);
  uploadHistoryList.innerHTML = renderUploadHistoryList(currentHistory);
  historyCount.textContent = String(currentHistory.length);

  if (currentHistory.length === 0) {
    historySummary.textContent = "Browse your recent uploads here once recordings are uploaded.";
    return;
  }

  historySummary.textContent = `${currentHistory.length} upload${currentHistory.length === 1 ? "" : "s"} saved locally.`;
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
      showError(result.error || "Failed to load upload history");
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
        showSuccess("Replay link copied.");
      } catch (error) {
        showError((error as Error).message || "Failed to copy replay link");
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
          showError(result.error || "Failed to delete history item");
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

void refreshHistory();

attachThemeToggle("theme-toggle-btn", "theme-toggle-icon");
