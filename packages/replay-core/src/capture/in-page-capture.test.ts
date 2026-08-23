/**
 * Tests for the in-page (MAIN world) capture core (Item 4).
 *
 * Covers:
 *  - Correctness Property P6 / Requirement R9.4: the cleanup function returned
 *    by `installInPageCapture()` restores every monkey-patched global
 *    (`console.*`, `fetch`, `XMLHttpRequest.prototype.open/send`, `WebSocket`)
 *    to its exact original reference.
 *  - Requirement R9.3: entries emitted by the in-page capture conform to the
 *    schemas the player already reads (`ConsoleEntry`, `StorageSnapshot`).
 *
 * The core is dependency-free and takes an injected `scope`, so these tests run
 * in the `node` Vitest environment with fake console/fetch/XHR/WebSocket
 * objects — no DOM is required.
 *
 * --- Manual verification (NOT automated here; tracked by task 21 "Manual") ---
 *  - R9.2: verify there is NO `chrome.debugger` banner when `captureMode ===
 *    "in-page"`. This lives in `service-worker.ts` (it skips
 *    `chrome.debugger.attach`) and must be confirmed by hand in a real
 *    Chromium session per DEVELOPER.md.
 *  - R9.6: verify behavior on a site with a strict Content-Security-Policy
 *    (MAIN-world injection blocked) — confirm a limitation is recorded and the
 *    user is advised to switch to `captureMode: "cdp"`.
 * These manual steps are intentionally not asserted automatically; do not
 * fabricate automated assertions for them.
 */

import { describe, expect, it } from "vitest";

import type {
  ConsoleEntry,
  SerializedRemoteObject,
  StorageKeyValue,
  StorageSnapshot,
} from "../schema/capture";
import {
  captureStorageSnapshot,
  type InPageCaptureKind,
  type InPageCaptureScope,
  installInPageCapture,
  parseInPageStackTrace,
  serializeConsoleArg,
  stripInPageCaptureFrames,
  toConsoleEntry,
} from "./in-page-capture";

// ---------------------------------------------------------------------------
// Fake scope builders
// ---------------------------------------------------------------------------

interface OriginalRefs {
  log: Console["log"];
  info: Console["info"];
  warn: Console["warn"];
  error: Console["error"];
  fetch: typeof fetch;
  xhrOpen: XMLHttpRequest["open"];
  xhrSend: XMLHttpRequest["send"];
  webSocket: typeof WebSocket;
}

/** Builds a fake scope plus the captured original references for comparison. */
function makeFakeScope(): { scope: InPageCaptureScope; originals: OriginalRefs } {
  // Distinct named functions so each restoration target is unambiguous.
  const log = function originalLog(): void {};
  const info = function originalInfo(): void {};
  const warn = function originalWarn(): void {};
  const error = function originalError(): void {};
  const debug = function originalDebug(): void {};
  const trace = function originalTrace(): void {};
  const fakeConsole = { log, info, warn, error, debug, trace } as unknown as Console;

  const fakeFetch = (() =>
    Promise.resolve({
      status: 200,
      statusText: "OK",
      headers: { get: () => null },
    })) as unknown as typeof fetch;

  class FakeXHR {
    open(): void {}
    send(): void {}
    addEventListener(): void {}
    removeEventListener(): void {}
    getAllResponseHeaders(): string {
      return "";
    }
    getResponseHeader(): string | null {
      return null;
    }
    status = 0;
    statusText = "";
  }

  function FakeWebSocket(): void {}
  (FakeWebSocket as unknown as Record<string, unknown>).CONNECTING = 0;
  (FakeWebSocket as unknown as Record<string, unknown>).OPEN = 1;
  (FakeWebSocket as unknown as Record<string, unknown>).CLOSING = 2;
  (FakeWebSocket as unknown as Record<string, unknown>).CLOSED = 3;

  const scope: InPageCaptureScope = {
    console: fakeConsole,
    fetch: fakeFetch,
    XMLHttpRequest: FakeXHR as unknown as typeof XMLHttpRequest,
    WebSocket: FakeWebSocket as unknown as typeof WebSocket,
    localStorage: makeFakeStorage({ theme: "dark", token: "abc" }),
    sessionStorage: makeFakeStorage({ cart: "1" }),
    document: { cookie: "sid=xyz; pref=compact" },
    location: { href: "https://example.test/page" },
    performance: { now: () => 1234 },
  };

  const originals: OriginalRefs = {
    log,
    info,
    warn,
    error,
    fetch: fakeFetch,
    xhrOpen: FakeXHR.prototype.open as XMLHttpRequest["open"],
    xhrSend: FakeXHR.prototype.send as XMLHttpRequest["send"],
    webSocket: FakeWebSocket as unknown as typeof WebSocket,
  };

  return { scope, originals };
}

/** Minimal in-memory Storage implementation for the injected scope. */
function makeFakeStorage(initial: Record<string, string>): Storage {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    key(index: number): string | null {
      return Array.from(map.keys())[index] ?? null;
    },
    getItem(key: string): string | null {
      return map.has(key) ? (map.get(key) as string) : null;
    },
    setItem(key: string, value: string): void {
      map.set(key, value);
    },
    removeItem(key: string): void {
      map.delete(key);
    },
    clear(): void {
      map.clear();
    },
  } as unknown as Storage;
}

/** Collects every entry passed to the capture `send` sink. */
function makeCollector(): {
  send: (
    sessionId: string,
    kind: InPageCaptureKind,
    entry: ConsoleEntry | StorageSnapshot | unknown,
  ) => void;
  entries: Array<{ kind: InPageCaptureKind; entry: unknown }>;
} {
  const entries: Array<{ kind: InPageCaptureKind; entry: unknown }> = [];
  return {
    entries,
    send: (_sessionId, kind, entry) => {
      entries.push({ kind, entry });
    },
  };
}

// ---------------------------------------------------------------------------
// Schema validators (mirror the player-read shapes in src/types/recording.ts)
// ---------------------------------------------------------------------------

function isSerializedRemoteObject(value: unknown): value is SerializedRemoteObject {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as SerializedRemoteObject).type === "string"
  );
}

function isConsoleEntry(value: unknown): value is ConsoleEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as ConsoleEntry;
  const sourceOk =
    entry.source === "console-api" || entry.source === "exception" || entry.source === "browser";
  const argsOk =
    entry.args === undefined ||
    (Array.isArray(entry.args) && entry.args.every(isSerializedRemoteObject));
  const messageOk = entry.message === undefined || typeof entry.message === "string";
  return (
    sourceOk &&
    typeof entry.level === "string" &&
    typeof entry.timestamp === "number" &&
    messageOk &&
    argsOk
  );
}

function isStorageKeyValue(value: unknown): value is StorageKeyValue {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const kv = value as StorageKeyValue;
  return typeof kv.key === "string" && typeof kv.value === "string";
}

function isStorageSnapshot(value: unknown): value is StorageSnapshot {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const snap = value as StorageSnapshot;
  return (
    (snap.phase === "start" || snap.phase === "stop") &&
    typeof snap.capturedAt === "number" &&
    Array.isArray(snap.localStorage) &&
    snap.localStorage.every(isStorageKeyValue) &&
    Array.isArray(snap.sessionStorage) &&
    snap.sessionStorage.every(isStorageKeyValue) &&
    Array.isArray(snap.cookies)
  );
}

// ---------------------------------------------------------------------------
// P6 / R9.4: cleanup restores all monkey-patched globals
// ---------------------------------------------------------------------------

describe("installInPageCapture cleanup (Property P6 / R9.4)", () => {
  it("patches globals on install and restores every original on cleanup", () => {
    const { scope, originals } = makeFakeScope();
    const proto = (scope.XMLHttpRequest as unknown as { prototype: XMLHttpRequest }).prototype;
    const { send } = makeCollector();

    const cleanup = installInPageCapture(scope, "session-1", send);

    // After install, every patched global must DIFFER from its original.
    expect(scope.console.log).not.toBe(originals.log);
    expect(scope.console.info).not.toBe(originals.info);
    expect(scope.console.warn).not.toBe(originals.warn);
    expect(scope.console.error).not.toBe(originals.error);
    expect(scope.fetch).not.toBe(originals.fetch);
    // XHR is patched on the prototype, not the constructor reference.
    expect(proto.open).not.toBe(originals.xhrOpen);
    expect(proto.send).not.toBe(originals.xhrSend);
    expect(scope.WebSocket).not.toBe(originals.webSocket);

    cleanup();

    // After cleanup, every global must be === its exact original reference.
    expect(scope.console.log).toBe(originals.log);
    expect(scope.console.info).toBe(originals.info);
    expect(scope.console.warn).toBe(originals.warn);
    expect(scope.console.error).toBe(originals.error);
    expect(scope.fetch).toBe(originals.fetch);
    expect(proto.open).toBe(originals.xhrOpen);
    expect(proto.send).toBe(originals.xhrSend);
    expect(scope.WebSocket).toBe(originals.webSocket);
  });

  it("is idempotent: a second cleanup call is a no-op and keeps originals", () => {
    const { scope, originals } = makeFakeScope();
    const { send } = makeCollector();

    const cleanup = installInPageCapture(scope, "session-2", send);
    cleanup();
    // Second invocation must not throw or re-patch.
    expect(() => cleanup()).not.toThrow();
    expect(scope.console.log).toBe(originals.log);
    expect(scope.fetch).toBe(originals.fetch);
  });
});

// ---------------------------------------------------------------------------
// R9.3: captured entries are valid player schema
// ---------------------------------------------------------------------------

describe("in-page captured entries match player schema (R9.3)", () => {
  it("emits a ConsoleEntry when a patched console method is called", () => {
    const { scope } = makeFakeScope();
    const { send, entries } = makeCollector();

    const cleanup = installInPageCapture(scope, "session-3", send);
    scope.console.log("hi", { a: 1 });
    cleanup();

    const consoleEntries = entries.filter((e) => e.kind === "console").map((e) => e.entry);
    expect(consoleEntries.length).toBe(1);

    const entry = consoleEntries[0];
    expect(isConsoleEntry(entry)).toBe(true);

    const consoleEntry = entry as ConsoleEntry;
    expect(consoleEntry.source).toBe("console-api");
    expect(consoleEntry.level).toBe("log");
    // Non-string args contribute their serialized `description` (class name).
    expect(consoleEntry.message).toBe("hi Object");
    expect(consoleEntry.args).toHaveLength(2);
    expect(consoleEntry.args?.[0]).toMatchObject({ type: "string", value: "hi" });
    expect(consoleEntry.args?.[1]?.type).toBe("object");
    expect(consoleEntry.stackTrace?.length).toBeGreaterThan(0);
    expect(
      stripInPageCaptureFrames([
        {
          functionName: "captureInPageStackTrace",
          url: "https://shop.test/assets/app.js",
          lineNumber: 1,
          columnNumber: 1,
        },
      ]),
    ).toHaveLength(1);
  });

  it("preserves the patched console method's pass-through behavior", () => {
    const { scope } = makeFakeScope();
    const calls: unknown[][] = [];
    // Swap in a spy original so we can confirm the patch still delegates.
    (scope.console as unknown as Record<string, unknown>).log = (...args: unknown[]) => {
      calls.push(args);
    };
    const { send } = makeCollector();

    const cleanup = installInPageCapture(scope, "session-4", send);
    scope.console.log("forwarded");
    cleanup();

    expect(calls).toEqual([["forwarded"]]);
  });

  it("maps console method names to player-compatible levels", () => {
    expect(toConsoleEntry("warn", ["x"]).level).toBe("warning");
    expect(toConsoleEntry("error", ["x"]).level).toBe("error");
    expect(toConsoleEntry("info", ["x"]).level).toBe("info");

    const entry = toConsoleEntry("log", ["msg", 42]);
    expect(isConsoleEntry(entry)).toBe(true);
    expect(entry.message).toBe("msg 42");
  });

  it("parses Chromium and Firefox caller stacks into player-compatible frames", () => {
    const chromium = parseInPageStackTrace(
      "Error\n    at submitOrder (https://shop.test/assets/app.js:42:17)\n    at HTMLButtonElement.onclick (https://shop.test/assets/app.js:68:5)",
    );
    const firefox = parseInPageStackTrace(
      "submitOrder@https://shop.test/assets/app.js:42:17\nonclick@https://shop.test/assets/app.js:68:5",
    );

    expect(chromium).toEqual([
      {
        functionName: "submitOrder",
        url: "https://shop.test/assets/app.js",
        lineNumber: 41,
        columnNumber: 16,
      },
      {
        functionName: "HTMLButtonElement.onclick",
        url: "https://shop.test/assets/app.js",
        lineNumber: 67,
        columnNumber: 4,
      },
    ]);
    expect(firefox).toEqual([
      chromium?.[0],
      {
        functionName: "onclick",
        url: "https://shop.test/assets/app.js",
        lineNumber: 67,
        columnNumber: 4,
      },
    ]);
  });

  it("removes recorder helper and extension wrapper frames while retaining app callers", () => {
    const frames = stripInPageCaptureFrames([
      {
        functionName: "captureInPageStackTrace",
        url: "chrome-extension://recorder/in-page.js",
        lineNumber: 1,
        columnNumber: 1,
      },
      {
        functionName: "patched",
        url: "moz-extension://recorder/in-page.js",
        lineNumber: 2,
        columnNumber: 1,
      },
      {
        functionName: "onRejection",
        url: "safari-web-extension://recorder/in-page.js",
        lineNumber: 3,
        columnNumber: 1,
      },
      {
        functionName: "patched",
        url: "https://shop.test/assets/app.js",
        lineNumber: 42,
        columnNumber: 17,
      },
    ]);

    expect(frames).toEqual([
      {
        functionName: "patched",
        url: "https://shop.test/assets/app.js",
        lineNumber: 42,
        columnNumber: 17,
      },
    ]);
  });

  it("serializeConsoleArg produces valid SerializedRemoteObject shapes", () => {
    expect(serializeConsoleArg("text")).toMatchObject({ type: "string", value: "text" });
    expect(serializeConsoleArg(7)).toMatchObject({ type: "number", value: 7 });
    expect(serializeConsoleArg(true)).toMatchObject({ type: "boolean", value: true });
    expect(serializeConsoleArg(null)).toMatchObject({ type: "object", subtype: "null" });
    expect(serializeConsoleArg(undefined)).toMatchObject({ type: "undefined" });
    expect(serializeConsoleArg([1, 2])).toMatchObject({ type: "object", subtype: "array" });

    for (const arg of ["s", 1, true, null, undefined, { a: 1 }, [1], () => {}]) {
      expect(isSerializedRemoteObject(serializeConsoleArg(arg))).toBe(true);
    }
  });

  it("captureStorageSnapshot returns a valid StorageSnapshot", () => {
    const { scope } = makeFakeScope();

    const start = captureStorageSnapshot(scope, "start");
    expect(isStorageSnapshot(start)).toBe(true);
    expect(start.phase).toBe("start");
    expect(start.localStorage).toEqual(
      expect.arrayContaining([
        { key: "theme", value: "dark" },
        { key: "token", value: "abc" },
      ]),
    );
    expect(start.sessionStorage).toEqual([{ key: "cart", value: "1" }]);
    expect(start.cookies).toEqual([
      { name: "sid", value: "xyz", domain: "", path: "/" },
      { name: "pref", value: "compact", domain: "", path: "/" },
    ]);
  });

  it("emits start and stop StorageSnapshots across the capture lifecycle", () => {
    const { scope } = makeFakeScope();
    const { send, entries } = makeCollector();

    const cleanup = installInPageCapture(scope, "session-5", send);
    const startSnap = entries.find((e) => e.kind === "storage")?.entry;
    expect(isStorageSnapshot(startSnap)).toBe(true);
    expect((startSnap as StorageSnapshot).phase).toBe("start");

    cleanup();

    const storageSnaps = entries
      .filter((e) => e.kind === "storage")
      .map((e) => e.entry as StorageSnapshot);
    expect(storageSnaps).toHaveLength(2);
    expect(storageSnaps.every(isStorageSnapshot)).toBe(true);
    expect(storageSnaps.map((s) => s.phase)).toEqual(["start", "stop"]);
  });

  it("flushes in-flight fetch as incomplete on cleanup without double-emit", async () => {
    const { scope } = makeFakeScope();
    let release!: (value: {
      status: number;
      statusText: string;
      headers: { get: () => string | null };
    }) => void;
    const delayed = new Promise<{
      status: number;
      statusText: string;
      headers: { get: () => string | null };
    }>((resolve) => {
      release = resolve;
    });
    scope.fetch = (() => delayed) as unknown as typeof fetch;

    const { send, entries } = makeCollector();
    const cleanup = installInPageCapture(scope, "session-inflight", send);

    const fetchPromise = scope.fetch("https://api.example.com/slow");
    // Yield so the patched fetch registers the pending entry.
    await Promise.resolve();

    cleanup();

    const networkAfterStop = entries
      .filter((e) => e.kind === "network")
      .map((e) => e.entry as { url: string; status: number | null; canceled?: boolean });
    expect(networkAfterStop).toHaveLength(1);
    expect(networkAfterStop[0]?.url).toContain("api.example.com/slow");
    expect(networkAfterStop[0]?.status).toBeNull();
    expect(networkAfterStop[0]?.canceled).not.toBe(true);

    release({
      status: 200,
      statusText: "OK",
      headers: { get: () => "application/json" },
    });
    await fetchPromise.catch(() => {});

    const networkFinal = entries.filter((e) => e.kind === "network");
    // Must not emit a second completed row after cleanup already flushed incomplete.
    expect(networkFinal).toHaveLength(1);
  });
});
