/**
 * MAIN-world in-page capture for full recording sessions (Firefox primary path).
 *
 * Monkey-patches console/fetch/XHR/WebSocket via replay-core. Posts entries to
 * the ISOLATED bridge — no chrome.* APIs in this world.
 *
 * STOP runs installInPageCapture cleanup (stop storage + inflight network),
 * then posts STOP_COMPLETE so the bridge can drain deliveries before ACKing SW.
 */

import {
  type InPageCaptureScope,
  installInPageCapture,
} from "../../packages/replay-core/src/capture/in-page-capture";
import {
  IN_PAGE_CAPTURE_TAG,
  type InPageCaptureControlMessage,
  type InPageCaptureEntryMessage,
  type InPageCaptureStopCompleteMessage,
  isInPageCaptureBridgeMessage,
} from "../shared/in-page-capture-bridge";

(() => {
  type CaptureWindow = Window & {
    __gnTracingInPageCaptureCleanup?: (() => void) | null;
    __gnTracingInPageCaptureListener?: boolean;
  };

  const pageWindow = window as CaptureWindow;
  if (pageWindow.__gnTracingInPageCaptureListener) {
    return;
  }
  pageWindow.__gnTracingInPageCaptureListener = true;

  const scope = window as unknown as InPageCaptureScope;

  function stopCapture(requestId?: string): void {
    // Cleanup emits stop storage + flushed network via the same postMessage path.
    pageWindow.__gnTracingInPageCaptureCleanup?.();
    pageWindow.__gnTracingInPageCaptureCleanup = null;

    if (requestId) {
      const done: InPageCaptureStopCompleteMessage = {
        [IN_PAGE_CAPTURE_TAG]: true,
        direction: "result",
        type: "STOP_COMPLETE",
        requestId,
      };
      window.postMessage(done, "*");
    }
  }

  function startCapture(sessionId: string): void {
    // Drop previous session without STOP_COMPLETE (no SW waiter).
    pageWindow.__gnTracingInPageCaptureCleanup?.();
    pageWindow.__gnTracingInPageCaptureCleanup = null;

    pageWindow.__gnTracingInPageCaptureCleanup = installInPageCapture(
      scope,
      sessionId,
      (_sessionId, kind, entry) => {
        const message: InPageCaptureEntryMessage = {
          [IN_PAGE_CAPTURE_TAG]: true,
          direction: "entry",
          sessionId,
          kind,
          entry,
        };
        window.postMessage(message, "*");
      },
    );
  }

  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window) {
      return;
    }
    const data = event.data;
    if (!isInPageCaptureBridgeMessage(data) || data.direction !== "control") {
      return;
    }
    const control = data as InPageCaptureControlMessage;
    if (control.type === "START" && control.sessionId) {
      startCapture(control.sessionId);
      return;
    }
    if (control.type === "STOP") {
      stopCapture(control.requestId);
    }
  });
})();
