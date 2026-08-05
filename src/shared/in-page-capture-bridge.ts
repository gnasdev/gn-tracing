/**
 * postMessage contract between MAIN in-page capture and ISOLATED bridge.
 */

import type { InPageCaptureKind } from "../../packages/replay-core/src/capture/in-page-capture";
import type {
  ConsoleEntry,
  NetworkEntry,
  StorageSnapshot,
  WebSocketEntry,
} from "../../packages/replay-core/src/schema/capture";

export const IN_PAGE_CAPTURE_TAG = "__gnTracingInPageCapture" as const;

export type InPageCaptureControlType = "START" | "STOP";

/**
 * Sentinel the MAIN world sets on its own global.
 *
 * The bridge reads it back through Firefox's Xray wrapper to prove the MAIN
 * script really landed in the page realm. Exported so both sides and the tests
 * agree on one name.
 */
export const IN_PAGE_CAPTURE_REALM_SENTINEL = "__gnTracingInPageCaptureListener" as const;

export interface InPageCaptureControlMessage {
  [IN_PAGE_CAPTURE_TAG]: true;
  direction: "control";
  type: InPageCaptureControlType;
  sessionId?: string;
  /** Present on STOP so MAIN can ack STOP_COMPLETE for this request. */
  requestId?: string;
  /**
   * Optional START fields. The bridge must forward every field present on the
   * SW → bridge message into the MAIN control postMessage — stripping them
   * here is how body/network policy silently fell back to defaults before.
   *
   * Kept as plain fields (not a nested options object) so this shared protocol
   * file stays free of a hard dependency on the capture module's option shape.
   */
  responseBodyMode?: "off" | "text" | "text-json" | "eligible";
  maxResponseBodyBytes?: number | null;
  /** When false, MAIN skips fetch/XHR patches. Omitted means true. */
  captureNetwork?: boolean;
}

export interface InPageCaptureEntryMessage {
  [IN_PAGE_CAPTURE_TAG]: true;
  direction: "entry";
  sessionId: string;
  kind: InPageCaptureKind;
  entry: ConsoleEntry | NetworkEntry | WebSocketEntry | StorageSnapshot;
}

export interface InPageCaptureStopCompleteMessage {
  [IN_PAGE_CAPTURE_TAG]: true;
  direction: "result";
  type: "STOP_COMPLETE";
  requestId: string;
}

export type InPageCaptureBridgeMessage =
  | InPageCaptureControlMessage
  | InPageCaptureEntryMessage
  | InPageCaptureStopCompleteMessage;

export function isInPageCaptureBridgeMessage(data: unknown): data is InPageCaptureBridgeMessage {
  if (!data || typeof data !== "object") {
    return false;
  }
  return (data as { [IN_PAGE_CAPTURE_TAG]?: unknown })[IN_PAGE_CAPTURE_TAG] === true;
}

export function isInPageCaptureStopComplete(
  data: unknown,
): data is InPageCaptureStopCompleteMessage {
  return (
    isInPageCaptureBridgeMessage(data) &&
    data.direction === "result" &&
    data.type === "STOP_COMPLETE"
  );
}

/**
 * Build the MAIN-world control postMessage from a SW → bridge START/STOP
 * payload. Forwards optional START policy fields when present so install
 * options match what the runtime intended.
 *
 * Exported for unit tests that drive the real shipped helper (not a reimplementation).
 */
export function buildInPageControlMessage(input: {
  type: InPageCaptureControlType;
  sessionId?: string;
  requestId?: string;
  responseBodyMode?: InPageCaptureControlMessage["responseBodyMode"];
  maxResponseBodyBytes?: number | null;
  captureNetwork?: boolean;
}): InPageCaptureControlMessage {
  const message: InPageCaptureControlMessage = {
    [IN_PAGE_CAPTURE_TAG]: true,
    direction: "control",
    type: input.type,
    sessionId: input.sessionId,
    requestId: input.requestId,
  };
  if (input.responseBodyMode !== undefined) {
    message.responseBodyMode = input.responseBodyMode;
  }
  if (input.maxResponseBodyBytes !== undefined) {
    message.maxResponseBodyBytes = input.maxResponseBodyBytes;
  }
  if (input.captureNetwork !== undefined) {
    message.captureNetwork = input.captureNetwork;
  }
  return message;
}

/** Service-worker action for forwarded entries (must match MessageAction). */
export const IN_PAGE_CAPTURE_ENTRY_ACTION = "IN_PAGE_CAPTURE_ENTRY" as const;

export type InPageCaptureMessageAction = typeof IN_PAGE_CAPTURE_ENTRY_ACTION;
