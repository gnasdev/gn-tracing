/**
 * postMessage bridge between Instant Replay ISOLATED orchestrator and MAIN-world
 * evidence capture. Tag is IR-specific so unrelated page messaging cannot clear
 * IR rings.
 */

import type { InstantReplayEvidenceBundle } from "../../packages/replay-core/src/capture/instant-replay-evidence";

export const IR_EVIDENCE_MESSAGE_TAG = "__gnTracingInstantReplayEvidence" as const;

export const IR_EVIDENCE_COLLECT_TIMEOUT_MS = 1_500;

export type IrEvidenceControlType =
  | "COLLECT"
  | "COMMIT"
  | "UPDATE_WINDOW"
  | "SET_STORAGE"
  | "PAUSE"
  | "RESUME"
  | "STOP";

export interface IrEvidenceControlMessage {
  [IR_EVIDENCE_MESSAGE_TAG]: true;
  direction: "control";
  type: IrEvidenceControlType;
  requestId?: string;
  windowMs?: number;
  captureStorage?: boolean;
}

export interface IrEvidenceCollectResultMessage {
  [IR_EVIDENCE_MESSAGE_TAG]: true;
  direction: "result";
  type: "COLLECT_RESULT";
  requestId: string;
  bundle: InstantReplayEvidenceBundle | null;
  disabledReason?: string | null;
}

export interface IrEvidenceAckMessage {
  [IR_EVIDENCE_MESSAGE_TAG]: true;
  direction: "result";
  type: "ACK";
  requestId?: string;
  ok: boolean;
}

export type IrEvidenceBridgeMessage =
  | IrEvidenceControlMessage
  | IrEvidenceCollectResultMessage
  | IrEvidenceAckMessage;

export function isIrEvidenceBridgeMessage(data: unknown): data is IrEvidenceBridgeMessage {
  if (!data || typeof data !== "object") {
    return false;
  }
  return (data as { [IR_EVIDENCE_MESSAGE_TAG]?: unknown })[IR_EVIDENCE_MESSAGE_TAG] === true;
}

export function makeRequestId(prefix = "ir-ev"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Ask MAIN evidence script for a non-destructive snapshot. Resolves null on timeout.
 */
export function requestEvidenceCollect(
  targetWindow: Window,
  timeoutMs: number = IR_EVIDENCE_COLLECT_TIMEOUT_MS,
): Promise<InstantReplayEvidenceBundle | null> {
  const requestId = makeRequestId("collect");
  return new Promise((resolve) => {
    let settled = false;
    const finish = (bundle: InstantReplayEvidenceBundle | null) => {
      if (settled) {
        return;
      }
      settled = true;
      targetWindow.removeEventListener("message", onMessage);
      resolve(bundle);
    };

    const onMessage = (event: MessageEvent) => {
      if (event.source !== targetWindow) {
        return;
      }
      const data = event.data;
      if (!isIrEvidenceBridgeMessage(data) || data.direction !== "result") {
        return;
      }
      if (data.type !== "COLLECT_RESULT" || data.requestId !== requestId) {
        return;
      }
      finish(data.bundle);
    };

    targetWindow.addEventListener("message", onMessage);
    const control: IrEvidenceControlMessage = {
      [IR_EVIDENCE_MESSAGE_TAG]: true,
      direction: "control",
      type: "COLLECT",
      requestId,
    };
    try {
      targetWindow.postMessage(control, "*");
    } catch {
      finish(null);
      return;
    }
    setTimeout(() => finish(null), timeoutMs);
  });
}

/** Pure control payload used by content scripts and service-worker injects. */
export function buildEvidenceControlMessage(
  type: IrEvidenceControlType,
  extra: Partial<Pick<IrEvidenceControlMessage, "requestId" | "windowMs" | "captureStorage">> = {},
): IrEvidenceControlMessage {
  return {
    [IR_EVIDENCE_MESSAGE_TAG]: true,
    direction: "control",
    type,
    ...extra,
  };
}

export function postEvidenceControl(
  targetWindow: Window,
  type: Exclude<IrEvidenceControlType, "COLLECT">,
  extra: Partial<Pick<IrEvidenceControlMessage, "windowMs" | "captureStorage">> = {},
): void {
  const control = buildEvidenceControlMessage(type, extra);
  try {
    targetWindow.postMessage(control, "*");
  } catch {
    // Page may be navigating away.
  }
}

/**
 * Normalize optional evidence from a collect response (content → SW).
 */
export function normalizeEvidenceBundle(value: unknown): InstantReplayEvidenceBundle | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const body = value as Partial<InstantReplayEvidenceBundle>;
  return {
    console: Array.isArray(body.console) ? body.console : [],
    network: Array.isArray(body.network) ? body.network : [],
    websocket: Array.isArray(body.websocket) ? body.websocket : [],
    storage: Array.isArray(body.storage) ? body.storage : [],
  };
}

export function evidenceBundleHasData(
  bundle: InstantReplayEvidenceBundle | null | undefined,
): boolean {
  if (!bundle) {
    return false;
  }
  return (
    bundle.console.length > 0 ||
    bundle.network.length > 0 ||
    bundle.websocket.length > 0 ||
    bundle.storage.length > 0
  );
}

/** Console / network / websocket only — storage alone must not mask a missing console ring. */
export function evidenceBundleHasLogData(
  bundle: InstantReplayEvidenceBundle | null | undefined,
): boolean {
  if (!bundle) {
    return false;
  }
  return bundle.console.length > 0 || bundle.network.length > 0 || bundle.websocket.length > 0;
}

/**
 * Per-kind merge: keep the longer ring for each surface so a storage-only
 * bridge result cannot hide MAIN-world console rows (and vice versa).
 */
export function mergeEvidenceBundles(
  primary: InstantReplayEvidenceBundle | null | undefined,
  fallback: InstantReplayEvidenceBundle | null | undefined,
): InstantReplayEvidenceBundle | null {
  if (!primary && !fallback) {
    return null;
  }
  const a = primary ?? {
    console: [],
    network: [],
    websocket: [],
    storage: [],
  };
  const b = fallback ?? {
    console: [],
    network: [],
    websocket: [],
    storage: [],
  };
  return {
    console: a.console.length >= b.console.length ? a.console : b.console,
    network: a.network.length >= b.network.length ? a.network : b.network,
    websocket: a.websocket.length >= b.websocket.length ? a.websocket : b.websocket,
    storage: a.storage.length >= b.storage.length ? a.storage : b.storage,
  };
}

/**
 * Force a structured-clone-safe plain object for postMessage / executeScript.
 * Large or exotic values (especially storage) can throw DataCloneError and
 * would otherwise drop the entire COLLECT_RESULT — including console rows.
 */
export function serializeEvidenceBundleForTransport(
  bundle: InstantReplayEvidenceBundle | null | undefined,
): InstantReplayEvidenceBundle | null {
  if (!bundle) {
    return null;
  }
  try {
    return JSON.parse(JSON.stringify(bundle)) as InstantReplayEvidenceBundle;
  } catch {
    // Drop storage first (often the largest / least cloneable), keep console.
    try {
      return JSON.parse(
        JSON.stringify({
          console: bundle.console,
          network: bundle.network,
          websocket: bundle.websocket,
          storage: [],
        }),
      ) as InstantReplayEvidenceBundle;
    } catch {
      return {
        console: [],
        network: [],
        websocket: [],
        storage: [],
      };
    }
  }
}

/**
 * Parse MAIN-world `JSON.stringify(recorder.collect())` results from
 * `chrome.scripting.executeScript`.
 */
export function parseMainWorldEvidenceJson(value: unknown): InstantReplayEvidenceBundle | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  try {
    return normalizeEvidenceBundle(JSON.parse(value));
  } catch {
    return null;
  }
}
