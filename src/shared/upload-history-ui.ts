/**
 * Shared renderer and click handling helpers for upload-history lists.
 */
import type { UploadHistoryEntry } from "../types/messages";

/**
 * Shared upload-history rendering and action routing.
 *
 * Popup and history page use the same markup/action attributes so replay links,
 * folder links, copy actions, and delete controls behave consistently across
 * both extension surfaces.
 */
export const POPUP_UPLOAD_HISTORY_LIMIT = 1;
export const HISTORY_PAGE_PATH = "history/history.html";

export function sortUploadHistoryNewestFirst(
  history: UploadHistoryEntry[] | undefined,
): UploadHistoryEntry[] {
  const items = Array.isArray(history) ? history : [];
  return [...items].sort((left, right) => (right.uploadedAt || 0) - (left.uploadedAt || 0));
}

export function getVisibleUploadHistory(
  history: UploadHistoryEntry[] | undefined,
  limit = POPUP_UPLOAD_HISTORY_LIMIT,
): { visibleItems: UploadHistoryEntry[]; hiddenCount: number } {
  const items = sortUploadHistoryNewestFirst(history);
  return {
    visibleItems: items.slice(0, limit),
    hiddenCount: Math.max(0, items.length - limit),
  };
}

export function renderUploadHistoryList(items: UploadHistoryEntry[] | undefined): string {
  const safeItems = sortUploadHistoryNewestFirst(items);
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
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="9"/>
      <path d="m10 8 6 4-6 4V8Z" fill="currentColor" stroke="none"/>
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

function getFolderIcon(): string {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 7h7l2 2h9v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>
      <path d="M3 7V5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v2"/>
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
