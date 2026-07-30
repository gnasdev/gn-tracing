/**
 * Park screenshot / Instant Replay package payloads for offscreen upload.
 *
 * chrome.runtime.sendMessage rejects ~64MiB payloads. SW and the offscreen
 * document share the extension origin, so bulk still + IR JSON live in
 * IndexedDB; the upload message only carries a stagingId (control plane).
 *
 * Separate from pending-ir-freeze-idb: freeze is structured lookback parked
 * for annotate; staging is package-ready (redacted) strings for one upload.
 */

const DB_NAME = "gn-tracing-upload-staging";
const DB_VERSION = 1;
const STORE_NAME = "screenshot-package";

export interface ScreenshotPackageStagingPayload {
  imageDataUrl: string;
  artifacts: Record<string, string>;
}

interface StagingRow {
  id: string;
  imageDataUrl: string;
  artifacts: Record<string, string>;
  storedAt: number;
}

/** In-memory fallback for unit tests / environments without IndexedDB. */
const memoryFallback = new Map<string, ScreenshotPackageStagingPayload>();

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => {
      reject(request.error ?? new Error("Could not open upload-staging IndexedDB."));
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

function normalizeArtifacts(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key === "string" && key && typeof value === "string" && value) {
      out[key] = value;
    }
  }
  return out;
}

function parseRow(row: StagingRow | undefined): ScreenshotPackageStagingPayload | null {
  if (!row || typeof row.id !== "string") {
    return null;
  }
  const imageDataUrl = typeof row.imageDataUrl === "string" ? row.imageDataUrl : "";
  const artifacts = normalizeArtifacts(row.artifacts);
  if (!imageDataUrl && Object.keys(artifacts).length === 0) {
    return null;
  }
  return { imageDataUrl, artifacts };
}

/**
 * Store package payload for offscreen to read. Replaces any previous row
 * for the same id.
 */
export async function putScreenshotPackageStaging(
  id: string,
  payload: ScreenshotPackageStagingPayload,
): Promise<void> {
  if (!id) {
    throw new Error("Missing screenshot package staging id.");
  }

  const imageDataUrl = typeof payload.imageDataUrl === "string" ? payload.imageDataUrl : "";
  const artifacts = normalizeArtifacts(payload.artifacts);
  if (!imageDataUrl && Object.keys(artifacts).length === 0) {
    throw new Error("Screenshot package staging has no image or artifacts.");
  }

  const normalized: ScreenshotPackageStagingPayload = { imageDataUrl, artifacts };

  if (typeof indexedDB === "undefined") {
    memoryFallback.set(id, {
      imageDataUrl: normalized.imageDataUrl,
      artifacts: { ...normalized.artifacts },
    });
    return;
  }

  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => {
        reject(tx.error ?? new Error("Could not store screenshot package staging."));
      };
      tx.onabort = () => {
        reject(tx.error ?? new Error("Screenshot package staging store aborted."));
      };
      const row: StagingRow = {
        id,
        imageDataUrl: normalized.imageDataUrl,
        artifacts: { ...normalized.artifacts },
        storedAt: Date.now(),
      };
      tx.objectStore(STORE_NAME).put(row);
    });
  } finally {
    db.close();
  }
}

/** Load staged payload, or null when missing/invalid. */
export async function getScreenshotPackageStaging(
  id: string,
): Promise<ScreenshotPackageStagingPayload | null> {
  if (!id) {
    return null;
  }

  if (typeof indexedDB === "undefined") {
    const memory = memoryFallback.get(id);
    if (!memory) {
      return null;
    }
    return {
      imageDataUrl: memory.imageDataUrl,
      artifacts: { ...memory.artifacts },
    };
  }

  const db = await openDb();
  try {
    const row = await new Promise<StagingRow | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const request = tx.objectStore(STORE_NAME).get(id);
      request.onsuccess = () => {
        resolve(request.result as StagingRow | undefined);
      };
      request.onerror = () => {
        reject(request.error ?? new Error("Could not read screenshot package staging."));
      };
    });
    return parseRow(row);
  } finally {
    db.close();
  }
}

/**
 * Clear one staging row by id, or every row when id is omitted.
 * Safe when nothing is stored.
 */
export async function clearScreenshotPackageStaging(id?: string): Promise<void> {
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
        reject(tx.error ?? new Error("Could not clear screenshot package staging."));
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
export function resetScreenshotPackageStagingMemoryForTests(): void {
  memoryFallback.clear();
}
