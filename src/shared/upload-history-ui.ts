/**
 * Shared renderer and click handling helpers for upload-history lists.
 */
import type { UploadHistoryEntry } from "../types/messages";
import { Icons } from "./icons";
import { resolveReplayOpenUrl } from "./player-host";
import { buildCloudRemoteOpenUrl, resolveHistoryProvider } from "./storage-provider";

/**
 * Shared upload-history rendering and action routing.
 *
 * Popup history dialog uses these markup/action attributes so replay links,
 * remote cloud opens, copy actions, and delete controls stay consistent.
 */

/** User-visible strings for the shared history list (EN defaults; surfaces override via setUploadHistoryUiLabels). */
export type UploadHistoryUiLabels = {
  empty: string;
  /** Template with `{time}` placeholder. */
  duration: string;
  replay: string;
  copyLink: string;
  openRemote: string;
  delete: string;
  unknownTime: string;
  unknownPage: string;
};

export const DEFAULT_UPLOAD_HISTORY_UI_LABELS: UploadHistoryUiLabels = {
  empty: "No uploads yet.",
  duration: "Duration: {time}",
  replay: "Replay",
  copyLink: "Copy link",
  openRemote: "Open remote",
  delete: "Delete",
  unknownTime: "Unknown time",
  unknownPage: "Unknown page",
};

let activeLabels: UploadHistoryUiLabels = { ...DEFAULT_UPLOAD_HISTORY_UI_LABELS };

/**
 * Apply localized labels used by `renderUploadHistoryList`, `formatDateTime`,
 * and `formatPageLabel`. Call from each surface when the UI language changes.
 */
export function setUploadHistoryUiLabels(labels: Partial<UploadHistoryUiLabels>): void {
  activeLabels = { ...DEFAULT_UPLOAD_HISTORY_UI_LABELS, ...labels };
}

function applyLabelTemplate(template: string, replacements: Record<string, string>): string {
  return Object.entries(replacements).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, value),
    template,
  );
}

export function sortUploadHistoryNewestFirst(
  history: UploadHistoryEntry[] | undefined,
): UploadHistoryEntry[] {
  const items = Array.isArray(history) ? history : [];
  return [...items].sort((left, right) => (right.uploadedAt || 0) - (left.uploadedAt || 0));
}

export function renderUploadHistoryList(items: UploadHistoryEntry[] | undefined): string {
  const safeItems = sortUploadHistoryNewestFirst(items);
  if (safeItems.length === 0) {
    return `<div class="history-empty">${escapeHtml(activeLabels.empty)}</div>`;
  }

  return safeItems
    .map(
      (item) => `
    <div class="history-item">
      <div class="history-item-title">${escapeHtml(formatPageLabel(item.pageUrl))}</div>
      <div class="history-item-meta">
        ${escapeHtml(formatDateTime(item.uploadedAt))}<br>
        ${escapeHtml(
          applyLabelTemplate(activeLabels.duration, { time: formatTime(item.durationMs) }),
        )}
      </div>
      <div class="history-item-actions">
        ${renderHistoryActionButton({
          action: "open-replay",
          label: activeLabels.replay,
          attrName: "data-url",
          attrValue: item.recordingUrl,
          icon: getReplayIcon(),
        })}
        ${renderHistoryActionButton({
          action: "copy-link",
          label: activeLabels.copyLink,
          attrName: "data-url",
          attrValue: item.recordingUrl,
          icon: getCopyIcon(),
        })}
        ${renderOpenRemoteButton(item)}
        ${renderHistoryActionButton({
          action: "delete-history",
          label: activeLabels.delete,
          attrName: "data-history-entry-id",
          attrValue: item.id,
          icon: getDeleteIcon(),
        })}
      </div>
    </div>
  `,
    )
    .join("");
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
      options.openExternalUrl(resolveReplayOpenUrl(url));
    }
    return true;
  }

  if (action === "copy-link") {
    const url = actionTarget.getAttribute("data-url");
    if (url) {
      // Same host rewrite as open-replay (dev builds → local player).
      await options.copyLink(resolveReplayOpenUrl(url) || url, actionTarget);
    }
    return true;
  }

  // "open-folder" kept as alias for older markup / session actions.
  if (action === "open-remote" || action === "open-folder") {
    const openUrl = buildCloudRemoteOpenUrl({
      provider: actionTarget.getAttribute("data-provider"),
      recordingUrl: actionTarget.getAttribute("data-recording-url"),
      folderRef: actionTarget.getAttribute("data-folder-id"),
      fileId: actionTarget.getAttribute("data-file-id"),
    });
    if (openUrl) {
      options.openExternalUrl(openUrl);
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

function renderOpenRemoteButton(item: UploadHistoryEntry): string {
  const folderRef = item.recordingFolderId || item.targetFolderId;
  const provider = resolveHistoryProvider(item.provider, item.recordingUrl);
  const openUrl = buildCloudRemoteOpenUrl({
    provider,
    recordingUrl: item.recordingUrl,
    folderRef,
  });
  if (!openUrl) {
    return "";
  }
  return renderHistoryActionButton({
    action: "open-remote",
    label: activeLabels.openRemote,
    attrName: "data-recording-url",
    attrValue: item.recordingUrl || "",
    icon: getFolderIcon(),
    extraAttrs: {
      "data-provider": provider,
      "data-folder-id": folderRef || "",
    },
  });
}

function renderHistoryActionButton(params: {
  action: string;
  label: string;
  attrName: string;
  attrValue: string;
  icon: string;
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
      class="history-icon-button"
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

function getReplayIcon(): string {
  return Icons.play();
}

function getCopyIcon(): string {
  return Icons.copy();
}

function getFolderIcon(): string {
  return Icons.folder();
}

function getDeleteIcon(): string {
  return Icons.trash();
}

export function formatDateTime(timestamp: number | null): string {
  if (!timestamp) {
    return activeLabels.unknownTime;
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
    return activeLabels.unknownPage;
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
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
