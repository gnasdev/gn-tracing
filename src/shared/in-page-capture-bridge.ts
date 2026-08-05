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

/** Service-worker action for forwarded entries (must match MessageAction). */
export const IN_PAGE_CAPTURE_ENTRY_ACTION = "IN_PAGE_CAPTURE_ENTRY" as const;

export type InPageCaptureMessageAction = typeof IN_PAGE_CAPTURE_ENTRY_ACTION;
