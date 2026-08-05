/**
 * ISOLATED bridge: control MAIN in-page capture and forward entries to the SW.
 *
 * STOP is asynchronous: MAIN must finish cleanup (and entry deliveries must
 * reach the service worker) before we answer the tabs.sendMessage waiter.
 */

import {
  IN_PAGE_CAPTURE_ENTRY_ACTION,
  IN_PAGE_CAPTURE_TAG,
  type InPageCaptureControlMessage,
  type InPageCaptureEntryMessage,
  isInPageCaptureBridgeMessage,
  isInPageCaptureStopComplete,
} from "../shared/in-page-capture-bridge";
import { awaitInPageStopDrain, makeInPageStopRequestId } from "../shared/in-page-stop-protocol";
import {
  type IsolatedScope,
  isRealmProbeFailure,
  probeMainWorldRealm,
} from "../shared/main-world-realm";

(() => {
  type BridgeWindow = Window & {
    __gnTracingInPageCaptureBridge?: boolean;
  };

  const pageWindow = window as BridgeWindow;
  if (pageWindow.__gnTracingInPageCaptureBridge) {
    return;
  }
  pageWindow.__gnTracingInPageCaptureBridge = true;

  /** In-flight SW deliveries for entry messages (must drain on STOP). */
  const pendingEntryDeliveries = new Set<Promise<unknown>>();

  function postControl(type: "START" | "STOP", sessionId?: string, requestId?: string): void {
    const message: InPageCaptureControlMessage = {
      [IN_PAGE_CAPTURE_TAG]: true,
      direction: "control",
      type,
      sessionId,
      requestId,
    };
    window.postMessage(message, "*");
  }

  function deliverEntryToServiceWorker(entryMessage: InPageCaptureEntryMessage): void {
    if (!chrome.runtime?.id) {
      return;
    }
    const delivery = chrome.runtime
      .sendMessage({
        action: IN_PAGE_CAPTURE_ENTRY_ACTION,
        sessionId: entryMessage.sessionId,
        kind: entryMessage.kind,
        entry: entryMessage.entry,
      })
      .catch(() => {});
    pendingEntryDeliveries.add(delivery);
    void delivery.finally(() => {
      pendingEntryDeliveries.delete(delivery);
    });
  }

  chrome.runtime.onMessage.addListener(
    (
      message: { target?: string; type?: string; sessionId?: string },
      _sender,
      sendResponse: (response: unknown) => void,
    ): boolean => {
      if (message?.target !== "in-page-capture") {
        return false;
      }
      if (message.type === "START" && message.sessionId) {
        postControl("START", message.sessionId);
        sendResponse({ ok: true });
        return false;
      }
      if (message.type === "VERIFY_REALM") {
        // Answered from the ISOLATED world on purpose: only this side can read
        // the page realm through Firefox's Xray wrapper and tell "the MAIN
        // script ran in the page" from "it ran in the sandbox".
        const probe = probeMainWorldRealm(window as unknown as IsolatedScope);
        sendResponse(
          isRealmProbeFailure(probe) ? { ok: false, error: probe.reason } : { ok: true },
        );
        return false;
      }
      if (message.type === "STOP") {
        const requestId = makeInPageStopRequestId();
        void awaitInPageStopDrain({
          requestId,
          postStopToMain: (id) => postControl("STOP", undefined, id),
          onStopComplete: (id, onComplete) => {
            const listener = (event: MessageEvent) => {
              if (event.source !== window) {
                return;
              }
              if (!isInPageCaptureStopComplete(event.data)) {
                return;
              }
              if (event.data.requestId !== id) {
                return;
              }
              window.removeEventListener("message", listener);
              onComplete();
            };
            window.addEventListener("message", listener);
            return () => window.removeEventListener("message", listener);
          },
          snapshotPendingDeliveries: () => Array.from(pendingEntryDeliveries),
        }).then((result) => {
          sendResponse(result);
        });
        // Keep the message channel open for the async drain.
        return true;
      }
      return false;
    },
  );

  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window) {
      return;
    }
    const data = event.data;
    if (!isInPageCaptureBridgeMessage(data) || data.direction !== "entry") {
      return;
    }
    deliverEntryToServiceWorker(data as InPageCaptureEntryMessage);
  });
})();
