/**
 * Popup navigation helpers: when to open a tab and when to dismiss the popup.
 *
 * Browser action popups do not always close themselves when a tab is opened
 * (especially on Firefox). Explicit close keeps "leave to a new tab" flows
 * consistent, while upload / in-popup work must keep the popup open.
 */

export type PopupTabOpenMode =
  /** Open a new tab and close the popup (replay, remote folder, manage clouds). */
  | "open-and-close-popup"
  /** Keep the popup open (upload progress, copy, delete, settings). */
  | "keep-popup-open";

/**
 * Whether opening an external/replay URL from the popup should dismiss it.
 * Uploaded-item navigation (replay / open remote) closes; upload does not.
 */
export function popupTabOpenModeForHistoryAction(
  action: string | null | undefined,
): PopupTabOpenMode {
  if (action === "open-replay" || action === "open-remote" || action === "open-folder") {
    return "open-and-close-popup";
  }
  return "keep-popup-open";
}

/**
 * Session-queue actions: only navigation opens close the popup.
 * `upload-session` must keep the popup so progress stays visible.
 */
export function popupTabOpenModeForSessionAction(
  action: string | null | undefined,
): PopupTabOpenMode {
  if (action === "open-replay" || action === "open-remote" || action === "open-folder") {
    return "open-and-close-popup";
  }
  return "keep-popup-open";
}

/**
 * Open a URL in a new tab, then optionally close the popup.
 * `createTab` and `closePopup` are injected so unit tests drive the real helper.
 */
export async function openPopupExternalUrl(
  url: string,
  options: {
    mode: PopupTabOpenMode;
    createTab: (url: string) => Promise<unknown> | unknown;
    closePopup: () => void;
  },
): Promise<void> {
  try {
    await options.createTab(url);
  } finally {
    if (options.mode === "open-and-close-popup") {
      options.closePopup();
    }
  }
}
