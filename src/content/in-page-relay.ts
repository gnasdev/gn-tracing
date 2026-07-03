/**
 * ISOLATED-world relay for `captureMode === "in-page"`.
 *
 * The MAIN-world capture script (`in-page-capture.ts`) cannot use
 * `chrome.runtime`, so this relay runs in the extension's ISOLATED world and
 * bridges the two transports:
 *
 *   service worker  ──(chrome.tabs.sendMessage)──▶  relay  ──(window.postMessage)──▶  MAIN
 *   MAIN  ──(window.postMessage)──▶  relay  ──(chrome.runtime.sendMessage)──▶  service worker
 *
 * Captured entries are forwarded as `RECORDING_INPAGE_ENTRY` messages. Redaction
 * and routing into `StorageManager` happen service-worker side (task 20).
 */

import { IN_PAGE_CAPTURE_MESSAGE_TAG, type InPageCaptureBridgeMessage } from "../types/messages";

(() => {
  type RelayWindow = Window & {
    __gnTracingInPageRelayInstalled?: boolean;
  };

  const relayWindow = window as RelayWindow;
  if (relayWindow.__gnTracingInPageRelayInstalled) {
    return;
  }
  relayWindow.__gnTracingInPageRelayInstalled = true;

  // MAIN world → service worker: forward captured entries.
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window) {
      return;
    }
    const data = event.data as Partial<InPageCaptureBridgeMessage> | null;
    if (!data || data[IN_PAGE_CAPTURE_MESSAGE_TAG] !== true || data.direction !== "entry") {
      return;
    }
    if (typeof data.sessionId !== "string" || !data.kind || !data.entry) {
      return;
    }
    // After an extension reload this old relay instance keeps running in the
    // page but its chrome.runtime is gone; sendMessage then throws
    // synchronously ("Extension context invalidated"), so guard and swallow.
    if (!chrome.runtime?.id) {
      return;
    }
    try {
      chrome.runtime
        .sendMessage({
          target: "service-worker",
          action: "RECORDING_INPAGE_ENTRY",
          data: {
            sessionId: data.sessionId,
            kind: data.kind,
            entry: data.entry,
          },
        })
        .catch(() => {});
    } catch {
      // Extension context invalidated between the guard and the call.
    }
  });

  // Service worker → MAIN world: relay START/STOP lifecycle control.
  chrome.runtime.onMessage.addListener(
    (
      message: { target?: string; type?: "START" | "STOP"; sessionId?: string },
      _sender,
      sendResponse,
    ) => {
      if (message.target !== "in-page-capture") {
        return false;
      }
      if (message.type === "START" || message.type === "STOP") {
        const control: InPageCaptureBridgeMessage = {
          [IN_PAGE_CAPTURE_MESSAGE_TAG]: true,
          direction: "control",
          type: message.type,
          sessionId: message.sessionId,
        };
        window.postMessage(control, "*");
        sendResponse({ ok: true });
      }
      return false;
    },
  );
})();
