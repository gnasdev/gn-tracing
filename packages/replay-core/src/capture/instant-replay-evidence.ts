/**
 * Rolling in-page evidence for Instant Replay (console / network / websocket /
 * storage) without streaming to a privileged host.
 *
 * Mirrors the DOM Instant Replay contract: buffers stay in page memory, are
 * trimmed by time + count/bytes, collect is non-destructive, and clear only
 * runs after a successful package commit. Capture reuses `installInPageCapture`
 * so artifact shapes match Record's in-page mode (no CDP).
 */

import type {
  ConsoleEntry,
  NetworkEntry,
  StorageSnapshot,
  WebSocketEntry,
} from "../schema/capture";
import {
  captureStorageSnapshot,
  type InPageCaptureKind,
  type InPageCaptureScope,
  installInPageCapture,
} from "./in-page-capture";

export interface InstantReplayEvidenceOptions {
  /** Lookback window; entries older than now − windowMs are dropped. */
  windowMs: number;
  maxConsoleEntries?: number;
  maxNetworkEntries?: number;
  maxWebsocketEntries?: number;
  /** Soft cap on approximate serialized size across all rings. */
  maxBytesApprox?: number;
  /** When false, storage snapshots are not retained. Default true. */
  captureStorage?: boolean;
}

export interface InstantReplayEvidenceBundle {
  console: ConsoleEntry[];
  network: NetworkEntry[];
  websocket: WebSocketEntry[];
  storage: StorageSnapshot[];
}

export interface InstantReplayEvidenceRecorder {
  updateWindowMs(ms: number): void;
  setCaptureStorage(enabled: boolean): void;
  collect(): InstantReplayEvidenceBundle;
  clear(): void;
  /** Uninstall patches and clear buffers. */
  stop(): void;
  readonly disabledReason: string | null;
}

export const DEFAULT_IR_EVIDENCE_MAX_CONSOLE = 500;
export const DEFAULT_IR_EVIDENCE_MAX_NETWORK = 300;
export const DEFAULT_IR_EVIDENCE_MAX_WEBSOCKET = 200;
export const DEFAULT_IR_EVIDENCE_MAX_BYTES = 3 * 1024 * 1024;

const SESSION_ID = "instant-replay-evidence";

function entryTimestamp(kind: InPageCaptureKind, entry: unknown): number {
  if (kind === "storage") {
    const snap = entry as StorageSnapshot;
    return typeof snap.capturedAt === "number" ? snap.capturedAt : Date.now();
  }
  if (kind === "network") {
    const net = entry as NetworkEntry;
    // Prefer wallTime: package schema stores epoch *seconds* for in-page rows.
    if (typeof net.wallTime === "number" && Number.isFinite(net.wallTime)) {
      return net.wallTime > 1e12 ? net.wallTime : net.wallTime * 1000;
    }
    if (typeof net.timestamp === "number" && net.timestamp > 1e11) {
      return net.timestamp;
    }
    return Date.now();
  }
  if (kind === "websocket") {
    const ws = entry as WebSocketEntry;
    const lastFrame = ws.frames?.[ws.frames.length - 1];
    if (lastFrame && typeof lastFrame.timestamp === "number") {
      return lastFrame.timestamp;
    }
    return Date.now();
  }
  const consoleEntry = entry as ConsoleEntry;
  return typeof consoleEntry.timestamp === "number" ? consoleEntry.timestamp : Date.now();
}

function approxBytes(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 64;
  } catch {
    return 256;
  }
}

/**
 * Starts always-on evidence capture against `scope` (usually `window`).
 */
export function startInstantReplayEvidence(
  scope: InPageCaptureScope,
  options: InstantReplayEvidenceOptions,
): InstantReplayEvidenceRecorder {
  let windowMs = Math.max(1_000, options.windowMs);
  let captureStorage = options.captureStorage !== false;
  const maxConsole = options.maxConsoleEntries ?? DEFAULT_IR_EVIDENCE_MAX_CONSOLE;
  const maxNetwork = options.maxNetworkEntries ?? DEFAULT_IR_EVIDENCE_MAX_NETWORK;
  const maxWebsocket = options.maxWebsocketEntries ?? DEFAULT_IR_EVIDENCE_MAX_WEBSOCKET;
  const maxBytes = options.maxBytesApprox ?? DEFAULT_IR_EVIDENCE_MAX_BYTES;

  const consoleRing: ConsoleEntry[] = [];
  const networkRing: NetworkEntry[] = [];
  const websocketRing: WebSocketEntry[] = [];
  let storageStart: StorageSnapshot | null = null;
  let disabledReason: string | null = null;
  let stopped = false;

  function trimRings(now: number = Date.now()): void {
    const cutoff = now - windowMs;

    const dropOlder = <T>(ring: T[], kind: InPageCaptureKind): void => {
      while (ring.length > 0 && entryTimestamp(kind, ring[0]) < cutoff) {
        ring.shift();
      }
    };

    dropOlder(consoleRing, "console");
    dropOlder(networkRing, "network");
    dropOlder(websocketRing, "websocket");

    while (consoleRing.length > maxConsole) {
      consoleRing.shift();
    }
    while (networkRing.length > maxNetwork) {
      networkRing.shift();
    }
    while (websocketRing.length > maxWebsocket) {
      websocketRing.shift();
    }

    // Soft byte budget across console + network + websocket (+ retained start snap).
    let bytes =
      approxBytes(consoleRing) +
      approxBytes(networkRing) +
      approxBytes(websocketRing) +
      (storageStart ? approxBytes(storageStart) : 0);

    const dropOldestAny = (): boolean => {
      const candidates: Array<{ kind: "console" | "network" | "websocket"; ts: number }> = [];
      if (consoleRing.length > 0) {
        candidates.push({ kind: "console", ts: entryTimestamp("console", consoleRing[0]) });
      }
      if (networkRing.length > 0) {
        candidates.push({ kind: "network", ts: entryTimestamp("network", networkRing[0]) });
      }
      if (websocketRing.length > 0) {
        candidates.push({
          kind: "websocket",
          ts: entryTimestamp("websocket", websocketRing[0]),
        });
      }
      if (candidates.length === 0) {
        return false;
      }
      candidates.sort((a, b) => a.ts - b.ts);
      const victim = candidates[0];
      if (victim.kind === "console") {
        consoleRing.shift();
      } else if (victim.kind === "network") {
        networkRing.shift();
      } else {
        websocketRing.shift();
      }
      return true;
    };

    while (bytes > maxBytes && dropOldestAny()) {
      bytes =
        approxBytes(consoleRing) +
        approxBytes(networkRing) +
        approxBytes(websocketRing) +
        (storageStart ? approxBytes(storageStart) : 0);
    }
  }

  function pushConsole(entry: ConsoleEntry): void {
    consoleRing.push(entry);
    trimRings(entryTimestamp("console", entry));
  }

  function pushNetwork(entry: NetworkEntry): void {
    networkRing.push(entry);
    trimRings(entryTimestamp("network", entry));
  }

  function upsertWebsocket(entry: WebSocketEntry): void {
    const idx = websocketRing.findIndex((row) => row.requestId === entry.requestId);
    if (idx >= 0) {
      websocketRing[idx] = entry;
    } else {
      websocketRing.push(entry);
    }
    trimRings(entryTimestamp("websocket", entry));
  }

  let cleanup: (() => void) | null = null;

  try {
    cleanup = installInPageCapture(scope, SESSION_ID, (_sessionId, kind, entry) => {
      if (stopped) {
        return;
      }
      try {
        if (kind === "console") {
          pushConsole(entry as ConsoleEntry);
          return;
        }
        if (kind === "network") {
          pushNetwork(entry as NetworkEntry);
          return;
        }
        if (kind === "websocket") {
          upsertWebsocket(entry as WebSocketEntry);
          return;
        }
        if (kind === "storage") {
          if (!captureStorage) {
            return;
          }
          const snap = entry as StorageSnapshot;
          // Keep only the lifecycle "start" snapshot while running; collect adds "stop".
          if (snap.phase === "start") {
            storageStart = snap;
          }
        }
      } catch (error) {
        disabledReason =
          error instanceof Error
            ? error.message
            : "Instant Replay evidence buffer failed; continuing without new entries.";
      }
    });
  } catch (error) {
    disabledReason =
      error instanceof Error
        ? error.message
        : "Instant Replay evidence could not start on this page.";
  }

  return {
    get disabledReason() {
      return disabledReason;
    },

    updateWindowMs(ms: number): void {
      windowMs = Math.max(1_000, ms);
      trimRings();
    },

    setCaptureStorage(enabled: boolean): void {
      captureStorage = enabled;
      if (!enabled) {
        storageStart = null;
      }
    },

    collect(): InstantReplayEvidenceBundle {
      trimRings();
      const storage: StorageSnapshot[] = [];
      if (captureStorage) {
        if (storageStart) {
          storage.push(storageStart);
        }
        try {
          storage.push(captureStorageSnapshot(scope, "stop"));
        } catch {
          // Storage may be blocked in the page; omit stop snapshot.
        }
      }
      return {
        console: consoleRing.slice(),
        network: networkRing.slice(),
        websocket: websocketRing.slice(),
        storage,
      };
    },

    clear(): void {
      consoleRing.length = 0;
      networkRing.length = 0;
      websocketRing.length = 0;
      // Re-baseline storage start after commit so the next package has a fresh start.
      if (captureStorage) {
        try {
          storageStart = captureStorageSnapshot(scope, "start");
        } catch {
          storageStart = null;
        }
      } else {
        storageStart = null;
      }
    },

    stop(): void {
      if (stopped) {
        return;
      }
      stopped = true;
      try {
        cleanup?.();
      } catch {
        // Restore best-effort.
      }
      cleanup = null;
      consoleRing.length = 0;
      networkRing.length = 0;
      websocketRing.length = 0;
      storageStart = null;
    },
  };
}
