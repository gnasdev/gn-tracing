/**
 * Park Instant Replay freeze payloads outside chrome.storage.session.
 *
 * Session storage is ~10MB total. An IR lookback can be 8MB DOM + evidence + a
 * still, so freeze must live in IndexedDB (extension-origin, survives SW kill
 * for the browser session) while the annotate still stays in session storage.
 */

import type { InstantReplayEvidenceBundle } from "../../packages/replay-core/src/capture/instant-replay-evidence";
import type { InstantReplayArtifact } from "../../packages/replay-core/src/schema/annotation";
import { hasInstantReplayFrames } from "../shared/instant-replay-policy";

const DB_NAME = "gn-tracing-pending-capture";
const DB_VERSION = 1;
const STORE_NAME = "ir-freeze";

export interface FrozenInstantReplayRecord {
  artifact: InstantReplayArtifact;
  evidence: InstantReplayEvidenceBundle | null;
}

interface IrFreezeRow {
  id: string;
  freeze: FrozenInstantReplayRecord;
  storedAt: number;
}

/** In-memory fallback for unit tests / environments without IndexedDB. */
const memoryFallback = new Map<string, FrozenInstantReplayRecord>();

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => {
      reject(request.error ?? new Error("Could not open pending-capture IndexedDB."));
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
  });
}

function parseFreeze(value: unknown): FrozenInstantReplayRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as FrozenInstantReplayRecord;
  if (!hasInstantReplayFrames(raw.artifact ?? null)) {
    return null;
  }
  return {
    artifact: raw.artifact,
    evidence: raw.evidence ?? null,
  };
}

/** Store freeze for a pending capture id. Replaces any previous freeze for that id. */
export async function putPendingIrFreeze(
  id: string,
  freeze: FrozenInstantReplayRecord,
): Promise<void> {
  if (!id || !hasInstantReplayFrames(freeze.artifact)) {
    throw new Error("Invalid Instant Replay freeze payload.");
  }

  if (typeof indexedDB === "undefined") {
    memoryFallback.set(id, {
      artifact: freeze.artifact,
      evidence: freeze.evidence ?? null,
    });
    return;
  }

  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => {
        reject(tx.error ?? new Error("Could not store Instant Replay lookback."));
      };
      tx.onabort = () => {
        reject(tx.error ?? new Error("Instant Replay lookback store aborted."));
      };
      const row: IrFreezeRow = {
        id,
        freeze: {
          artifact: freeze.artifact,
          evidence: freeze.evidence ?? null,
        },
        storedAt: Date.now(),
      };
      tx.objectStore(STORE_NAME).put(row);
    });
  } finally {
    db.close();
  }
}

/** Load freeze for a pending capture id, or null when missing/invalid. */
export async function getPendingIrFreeze(id: string): Promise<FrozenInstantReplayRecord | null> {
  if (!id) {
    return null;
  }

  if (typeof indexedDB === "undefined") {
    return memoryFallback.get(id) ?? null;
  }

  const db = await openDb();
  try {
    const row = await new Promise<IrFreezeRow | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const request = tx.objectStore(STORE_NAME).get(id);
      request.onsuccess = () => {
        resolve(request.result as IrFreezeRow | undefined);
      };
      request.onerror = () => {
        reject(request.error ?? new Error("Could not read Instant Replay lookback."));
      };
    });
    return parseFreeze(row?.freeze);
  } finally {
    db.close();
  }
}

/**
 * Clear one freeze by id, or every parked freeze when id is omitted.
 * Safe to call when nothing is stored.
 */
export async function clearPendingIrFreeze(id?: string): Promise<void> {
  if (typeof indexedDB === "undefined") {
    if (id) {
      memoryFallback.delete(id);
    } else {
      memoryFallback.clear();
    }
    return;
  }

  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => {
        reject(tx.error ?? new Error("Could not clear Instant Replay lookback."));
      };
      const store = tx.objectStore(STORE_NAME);
      if (id) {
        store.delete(id);
      } else {
        store.clear();
      }
    });
  } finally {
    db.close();
  }
}

/** Test-only: wipe memory fallback between unit tests. */
export function resetPendingIrFreezeMemoryForTests(): void {
  memoryFallback.clear();
}
