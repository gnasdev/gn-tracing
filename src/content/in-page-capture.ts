/**
 * MAIN-world content script for `captureMode === "in-page"`.
 *
 * The service worker injects this file with `world: "MAIN"` so it can see the
 * page's real `console`, `fetch`, `XMLHttpRequest`, and `WebSocket`. A MAIN-world
 * script cannot use `chrome.runtime`, so captured entries are posted to the
 * page via `window.postMessage` using a tagged protocol; the ISOLATED-world
 * relay (`in-page-relay.ts`) forwards them to the service worker.
 *
 * Lifecycle (START/STOP) is likewise received from the relay over the same
 * bridge. Installation is idempotent — guarded by a window flag like
 * `recording-events.ts` — and STOP runs the cleanup returned by
 * `installInPageCapture`, restoring every patched global (Requirement R9.4).
 */

import { IN_PAGE_CAPTURE_MESSAGE_TAG, type InPageCaptureBridgeMessage } from "../types/messages";
import {
  type InPageCaptureScope,
  type InPageCaptureSend,
  installInPageCapture,
} from "./in-page-capture-core";

(() => {
  type CaptureWindow = Window & {
    __gnTracingInPageCapture?: { sessionId: string; cleanup: () => void };
    __gnTracingInPageCaptureBridgeInstalled?: boolean;
  };

  const pageWindow = window as CaptureWindow;

  // `window` structurally satisfies InPageCaptureScope. Passing it directly
  // means the core's reassignments (`scope.fetch = ...`, `scope.WebSocket = ...`)
  // and prototype patches land on the real page globals, and cleanup restores
  // the exact original references on `window`.
  const scope = window as unknown as InPageCaptureScope;

  const send: InPageCaptureSend = (sessionId, kind, entry) => {
    const message: InPageCaptureBridgeMessage = {
      [IN_PAGE_CAPTURE_MESSAGE_TAG]: true,
      direction: "entry",
      sessionId,
      kind,
      entry,
    };
    try {
      window.postMessage(message, "*");
    } catch {
      // postMessage can throw on non-cloneable payloads; drop the entry.
    }
  };

  function start(sessionId: string): void {
    pageWindow.__gnTracingInPageCapture?.cleanup();
    const cleanup = installInPageCapture(scope, sessionId, send);
    pageWindow.__gnTracingInPageCapture = {
      sessionId,
      cleanup: () => {
        cleanup();
        delete pageWindow.__gnTracingInPageCapture;
      },
    };
  }

  function stop(): void {
    pageWindow.__gnTracingInPageCapture?.cleanup();
  }

  if (!pageWindow.__gnTracingInPageCaptureBridgeInstalled) {
    window.addEventListener("message", (event: MessageEvent) => {
      if (event.source !== window) {
        return;
      }
      const data = event.data as Partial<InPageCaptureBridgeMessage> | null;
      if (!data || data[IN_PAGE_CAPTURE_MESSAGE_TAG] !== true || data.direction !== "control") {
        return;
      }
      if (data.type === "START" && typeof data.sessionId === "string" && data.sessionId) {
        start(data.sessionId);
      } else if (data.type === "STOP") {
        stop();
      }
    });
    pageWindow.__gnTracingInPageCaptureBridgeInstalled = true;
  }
})();
