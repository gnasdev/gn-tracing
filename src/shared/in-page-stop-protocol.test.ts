/**
 * Proves Firefox stop drain waits for MAIN cleanup emissions before the SW
 * can finalize the session (skeptic: stop storage + inflight network lost).
 *
 * Drives real installInPageCapture cleanup + StorageManager ingest path used
 * by FirefoxRecordingRuntime — not a reimplementation of capture.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type InPageCaptureScope,
  installInPageCapture,
} from "../../packages/replay-core/src/capture/in-page-capture";
import { StorageManager } from "../background/storage-manager";
import type { ConsoleEntry, NetworkEntry, StorageSnapshot } from "../types/recording";
import { awaitInPageStopDrain, makeInPageStopRequestId } from "./in-page-stop-protocol";

function makeScope(): InPageCaptureScope & {
  localStorage: Storage;
  sessionStorage: Storage;
  document: { cookie: string };
  location: { href: string };
  performance: { now(): number };
} {
  const store = new Map<string, string>();
  const storage = {
    get length() {
      return store.size;
    },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
  } as Storage;

  return {
    console,
    fetch: undefined,
    XMLHttpRequest: undefined,
    WebSocket: undefined,
    localStorage: storage,
    sessionStorage: storage,
    document: { cookie: "a=1" },
    location: { href: "https://app.example/page" },
    performance: { now: () => 1000 },
  };
}

/**
 * Mirrors FirefoxRecordingRuntime.ingestEvidenceEntry (shipped path).
 * Network is intentionally dropped: full-record network is owned by webRequest.
 */
function ingestIntoStorage(
  storage: StorageManager,
  kind: string,
  entry: ConsoleEntry | NetworkEntry | StorageSnapshot,
): void {
  if (kind === "console") {
    storage.addConsoleEntry(entry as ConsoleEntry);
    return;
  }
  if (kind === "network") {
    return;
  }
  if (kind === "storage") {
    storage.setStorageSnapshot(entry as StorageSnapshot);
  }
}

function parseStoragePhases(finalized: { storageSnapshots?: string }): string[] {
  if (!finalized.storageSnapshots) {
    return [];
  }
  const parsed = JSON.parse(finalized.storageSnapshots) as {
    snapshots: Array<{ phase?: string }>;
  };
  return (parsed.snapshots || []).map((s) => s.phase || "");
}

describe("awaitInPageStopDrain", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for STOP_COMPLETE and pending entry deliveries before resolving", async () => {
    const requestId = makeInPageStopRequestId();
    let completeCb: (() => void) | null = null;
    let postStopCalled = false;

    let resolveDelivery!: () => void;
    const slowDelivery = new Promise<void>((resolve) => {
      resolveDelivery = resolve;
    });
    let deliveryStarted = false;

    const drainPromise = awaitInPageStopDrain({
      requestId,
      postStopToMain: (id) => {
        expect(id).toBe(requestId);
        postStopCalled = true;
        deliveryStarted = true;
        queueMicrotask(() => {
          completeCb?.();
        });
      },
      onStopComplete: (id, onComplete) => {
        expect(id).toBe(requestId);
        completeCb = onComplete;
        return () => {
          completeCb = null;
        };
      },
      snapshotPendingDeliveries: () => (deliveryStarted ? [slowDelivery] : []),
      timeoutMs: 500,
    });

    let settled = false;
    void drainPromise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(postStopCalled).toBe(true);
    // Still waiting on slowDelivery
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveDelivery();
    const result = await drainPromise;
    expect(result.ok).toBe(true);
    expect(settled).toBe(true);
  });

  it("times out when STOP_COMPLETE never arrives", async () => {
    vi.useFakeTimers();
    const drainPromise = awaitInPageStopDrain({
      requestId: "rid-timeout",
      postStopToMain: () => {},
      onStopComplete: () => () => {},
      snapshotPendingDeliveries: () => [],
      timeoutMs: 50,
    });
    await vi.advanceTimersByTimeAsync(60);
    const result = await drainPromise;
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
  });
});

describe("Firefox stop evidence drain (real installInPageCapture + StorageManager)", () => {
  it("lands stop storage from cleanup in storage before finalizeCurrentSession", async () => {
    const sessionId = "sess-drain-1";
    const storage = new StorageManager();
    storage.beginSession();
    const scope = makeScope();
    scope.localStorage.setItem("token", "secret");

    const pendingDeliveries = new Set<Promise<unknown>>();

    const cleanup = installInPageCapture(scope, sessionId, (_sid, kind, entry) => {
      // Async delivery latency like chrome.runtime.sendMessage.
      const delivery = new Promise<void>((resolve) => {
        setTimeout(() => {
          ingestIntoStorage(storage, kind, entry as never);
          resolve();
        }, 8);
      });
      pendingDeliveries.add(delivery);
      void delivery.finally(() => pendingDeliveries.delete(delivery));
    });

    // Let start storage land.
    await Promise.allSettled(Array.from(pendingDeliveries));

    const requestId = makeInPageStopRequestId();
    let stopCompleteFired = false;

    const drainResult = await awaitInPageStopDrain({
      requestId,
      postStopToMain: () => {
        // MAIN: cleanup emits stop storage via delayed deliveries, then COMPLETE.
        cleanup();
        stopCompleteFired = true;
      },
      onStopComplete: (_id, onComplete) => {
        queueMicrotask(() => {
          if (stopCompleteFired) {
            onComplete();
          }
        });
        return () => {};
      },
      snapshotPendingDeliveries: () => Array.from(pendingDeliveries),
      timeoutMs: 1_000,
    });

    expect(drainResult.ok).toBe(true);

    // All cleanup emits must be in storage *before* finalize (SW order).
    const finalized = storage.finalizeCurrentSession();
    const phases = parseStoragePhases(finalized);
    expect(phases).toContain("start");
    expect(phases).toContain("stop");
  });

  it("loses stop storage when finalize races ahead of delayed cleanup ingest", async () => {
    // Documents the bug fixed by awaitInPageStopDrain: early finalize drops stop.
    const sessionId = "sess-race";
    const storage = new StorageManager();
    storage.beginSession();
    const scope = makeScope();

    const cleanup = installInPageCapture(scope, sessionId, (_sid, kind, entry) => {
      setTimeout(() => {
        ingestIntoStorage(storage, kind, entry as never);
      }, 25);
    });

    // Start emit scheduled but not required for this assertion.
    await new Promise((r) => setTimeout(r, 5));
    cleanup(); // schedules stop emit with delay — do NOT await

    // Buggy SW path: finalize immediately after bridge ACKed STOP early.
    const buggy = storage.finalizeCurrentSession();
    expect(parseStoragePhases(buggy)).not.toContain("stop");

    await new Promise((r) => setTimeout(r, 40));
  });
});
