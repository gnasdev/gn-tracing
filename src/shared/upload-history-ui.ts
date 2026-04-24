import type { UploadHistoryEntry } from "../types/messages";

export const POPUP_UPLOAD_HISTORY_LIMIT = 5;
export const HISTORY_PAGE_PATH = "history/history.html";

export function getVisibleUploadHistory(
  history: UploadHistoryEntry[] | undefined,
  limit = POPUP_UPLOAD_HISTORY_LIMIT,
): { visibleItems: UploadHistoryEntry[]; hiddenCount: number } {
  const items = Array.isArray(history) ? history : [];
  return {
    visibleItems: items.slice(0, limit),
    hiddenCount: Math.max(0, items.length - limit),
  };
}

export function renderUploadHistoryList(items: UploadHistoryEntry[] | undefined): string {
  const safeItems = Array.isArray(items) ? items : [];
  if (safeItems.length === 0) {
    return `<div class="history-empty">No uploads yet.</div>`;
  }

  return safeItems.map((item) => `
    <div class="history-item">
      <div class="history-item-title">${escapeHtml(formatPageLabel(item.pageUrl))}</div>
      <div class="history-item-meta">
        ${escapeHtml(formatDateTime(item.uploadedAt))}<br>
        Duration: ${escapeHtml(formatTime(item.durationMs))}
      </div>
      <div class="history-item-actions">
        ${renderHistoryActionButton({
          action: "open-replay",
          label: "Replay",
          attrName: "data-url",
          attrValue: item.recordingUrl,
          icon: getReplayIcon(),
        })}
        ${renderHistoryActionButton({
          action: "copy-link",
          label: "Copy link",
          attrName: "data-url",
          attrValue: item.recordingUrl,
          icon: getCopyIcon(),
        })}
        ${renderHistoryActionButton({
          action: "open-folder",
          label: "Open folder",
          attrName: "data-folder-id",
          attrValue: item.recordingFolderId,
          icon: getFolderIcon(),
        })}
        ${renderHistoryActionButton({
          action: "delete-history",
          label: "Delete",
          attrName: "data-history-entry-id",
          attrValue: item.id,
          icon: getDeleteIcon(),
        })}
      </div>
    </div>
  `).join("");
}

export async function handleUploadHistoryAction(
  target: HTMLElement | null,
  options: {
    openExternalUrl: (url: string) => void;
    copyLink: (url: string, button: HTMLButtonElement) => Promise<void>;
    deleteHistoryEntry: (historyEntryId: string, button: HTMLButtonElement) => Promise<void>;
  },
): Promise<boolean> {
  if (!target) {
    return false;
  }

  const actionTarget = target.closest<HTMLButtonElement>("[data-action]");
  if (!actionTarget) {
    return false;
  }

  const action = actionTarget.getAttribute("data-action");
  if (action === "open-replay") {
    const url = actionTarget.getAttribute("data-url");
    if (url) {
      options.openExternalUrl(url);
    }
    return true;
  }

  if (action === "copy-link") {
    const url = actionTarget.getAttribute("data-url");
    if (url) {
      await options.copyLink(url, actionTarget);
    }
    return true;
  }

  if (action === "open-folder") {
    const folderId = actionTarget.getAttribute("data-folder-id");
    if (folderId) {
      options.openExternalUrl(`https://drive.google.com/drive/folders/${folderId}`);
    }
    return true;
  }

  if (action === "delete-history") {
    const historyEntryId = actionTarget.getAttribute("data-history-entry-id");
    if (!historyEntryId) {
      return true;
    }
    await options.deleteHistoryEntry(historyEntryId, actionTarget);
    return true;
  }

  return false;
}

function renderHistoryActionButton(params: {
  action: string;
  label: string;
  attrName: string;
  attrValue: string;
  icon: string;
}): string {
  return `
    <button
      type="button"
      class="history-icon-button"
      data-action="${params.action}"
      ${params.attrName}="${escapeHtml(params.attrValue)}"
      aria-label="${escapeHtml(params.label)}"
      title="${escapeHtml(params.label)}"
    >
      ${params.icon}
    </button>
  `;
}

function getReplayIcon(): string {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M8 6.82v10.36c0 .79.87 1.27 1.54.84l8.14-5.18a1 1 0 0 0 0-1.68L9.54 5.98A1 1 0 0 0 8 6.82Z" fill="currentColor"/>
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

function getFolderIcon(): string {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M3 7a2 2 0 0 1 2-2h4.17c.53 0 1.04.21 1.41.59l1.83 1.82c.19.19.44.29.71.29H19a2 2 0 0 1 2 2v1H3V7Zm0 5h18l-1.6 6.4A2 2 0 0 1 17.46 20H6.54a2 2 0 0 1-1.94-1.6L3 12Z" fill="currentColor"/>
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

export function formatDateTime(timestamp: number | null): string {
  if (!timestamp) {
    return "Unknown time";
  }
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "short",
      timeStyle: "short",
    }).format(timestamp);
  } catch {
    return new Date(timestamp).toLocaleString();
  }
}

export function formatPageLabel(url: string | null | undefined): string {
  if (!url) {
    return "Unknown page";
  }
  try {
    const parsed = new URL(url);
    return parsed.hostname + parsed.pathname;
  } catch {
    return url;
  }
}

export function formatTime(ms: number): string {
  const totalSec = Math.floor(Math.max(0, ms) / 1000);
  const min = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const sec = String(totalSec % 60).padStart(2, "0");
  return `${min}:${sec}`;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}
