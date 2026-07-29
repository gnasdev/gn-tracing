/**
 * MAIN-world Instant Replay evidence capture.
 *
 * Patches page console/fetch/XHR/WebSocket and keeps rolling rings in memory.
 * Controlled via postMessage from the ISOLATED Instant Replay content script
 * (see `instant-replay-evidence-bridge.ts`). No chrome.* APIs.
 */

import {
  DEFAULT_INSTANT_REPLAY_WINDOW_MS,
  type InPageCaptureScope,
  type InstantReplayEvidenceRecorder,
  startInstantReplayEvidence,
} from "../../packages/replay-core/src/capture";
import {
  IR_EVIDENCE_MESSAGE_TAG,
  type IrEvidenceAckMessage,
  type IrEvidenceBridgeMessage,
  type IrEvidenceCollectResultMessage,
  type IrEvidenceControlMessage,
  isIrEvidenceBridgeMessage,
  serializeEvidenceBundleForTransport,
} from "../shared/instant-replay-evidence-bridge";

(() => {
  type EvidenceWindow = Window & {
    __gnTracingInstantReplayEvidence?: InstantReplayEvidenceRecorder;
    __gnTracingInstantReplayEvidenceBridge?: boolean;
    __gnTracingInstantReplayEvidencePaused?: boolean;
    __gnTracingInstantReplayEvidenceOptions?: {
      windowMs: number;
      captureStorage: boolean;
    };
  };

  const pageWindow = window as EvidenceWindow;
  if (pageWindow.__gnTracingInstantReplayEvidenceBridge) {
    return;
  }
  pageWindow.__gnTracingInstantReplayEvidenceBridge = true;

  const scope = window as unknown as InPageCaptureScope;

  function currentOptions(): { windowMs: number; captureStorage: boolean } {
    return (
      pageWindow.__gnTracingInstantReplayEvidenceOptions ?? {
        windowMs: DEFAULT_INSTANT_REPLAY_WINDOW_MS,
        captureStorage: true,
      }
    );
  }

  function startRecorder(): InstantReplayEvidenceRecorder {
    pageWindow.__gnTracingInstantReplayEvidence?.stop();
    const opts = currentOptions();
    const recorder = startInstantReplayEvidence(scope, {
      windowMs: opts.windowMs,
      captureStorage: opts.captureStorage,
    });
    pageWindow.__gnTracingInstantReplayEvidence = recorder;
    pageWindow.__gnTracingInstantReplayEvidencePaused = false;
    return recorder;
  }

  function ensureRecorder(): InstantReplayEvidenceRecorder | null {
    if (pageWindow.__gnTracingInstantReplayEvidencePaused) {
      return null;
    }
    if (pageWindow.__gnTracingInstantReplayEvidence) {
      return pageWindow.__gnTracingInstantReplayEvidence;
    }
    return startRecorder();
  }

  function pause(): void {
    pageWindow.__gnTracingInstantReplayEvidence?.stop();
    delete pageWindow.__gnTracingInstantReplayEvidence;
    pageWindow.__gnTracingInstantReplayEvidencePaused = true;
  }

  function resume(): void {
    pageWindow.__gnTracingInstantReplayEvidencePaused = false;
    startRecorder();
  }

  function postResult(message: IrEvidenceCollectResultMessage | IrEvidenceAckMessage): void {
    try {
      window.postMessage(message, "*");
    } catch {
      // Ignore clone failures.
    }
  }

  function handleControl(data: IrEvidenceControlMessage): void {
    switch (data.type) {
      case "COLLECT": {
        const requestId = data.requestId || "collect";
        const recorder = ensureRecorder();
        // JSON round-trip so postMessage never DataCloneError-drops the whole
        // result (which would make Instant Replay packages look console-empty).
        const bundle = serializeEvidenceBundleForTransport(recorder?.collect() ?? null);
        const result: IrEvidenceCollectResultMessage = {
          [IR_EVIDENCE_MESSAGE_TAG]: true,
          direction: "result",
          type: "COLLECT_RESULT",
          requestId,
          bundle,
          disabledReason: recorder?.disabledReason ?? null,
        };
        postResult(result);
        break;
      }
      case "COMMIT": {
        const recorder = pageWindow.__gnTracingInstantReplayEvidence;
        recorder?.clear();
        postResult({
          [IR_EVIDENCE_MESSAGE_TAG]: true,
          direction: "result",
          type: "ACK",
          requestId: data.requestId,
          ok: true,
        });
        break;
      }
      case "UPDATE_WINDOW": {
        if (typeof data.windowMs === "number" && data.windowMs > 0) {
          const opts = currentOptions();
          opts.windowMs = data.windowMs;
          pageWindow.__gnTracingInstantReplayEvidenceOptions = opts;
          pageWindow.__gnTracingInstantReplayEvidence?.updateWindowMs(data.windowMs);
        }
        break;
      }
      case "SET_STORAGE": {
        if (typeof data.captureStorage === "boolean") {
          const opts = currentOptions();
          opts.captureStorage = data.captureStorage;
          pageWindow.__gnTracingInstantReplayEvidenceOptions = opts;
          pageWindow.__gnTracingInstantReplayEvidence?.setCaptureStorage(data.captureStorage);
        }
        break;
      }
      case "PAUSE":
        pause();
        break;
      case "RESUME":
        resume();
        break;
      case "STOP":
        pageWindow.__gnTracingInstantReplayEvidence?.stop();
        delete pageWindow.__gnTracingInstantReplayEvidence;
        pageWindow.__gnTracingInstantReplayEvidencePaused = true;
        break;
      default:
        break;
    }
  }

  // Auto-start so lookback begins as soon as the MAIN script injects.
  ensureRecorder();

  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window) {
      return;
    }
    const data = event.data as IrEvidenceBridgeMessage | null;
    if (!isIrEvidenceBridgeMessage(data) || data.direction !== "control") {
      return;
    }
    handleControl(data);
  });

  window.addEventListener("pagehide", () => {
    pageWindow.__gnTracingInstantReplayEvidence?.stop();
    delete pageWindow.__gnTracingInstantReplayEvidence;
  });
})();
