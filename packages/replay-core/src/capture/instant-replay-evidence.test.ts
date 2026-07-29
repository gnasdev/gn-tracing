/**
 * Instant Replay evidence ring: window trim, caps, non-destructive collect,
 * storage gating, and patch cleanup.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { InPageCaptureScope } from "./in-page-capture";
import { startInstantReplayEvidence } from "./instant-replay-evidence";

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

function makeFakeScope(): InPageCaptureScope {
  const log = function originalLog(..._args: unknown[]): void {};
  const info = function originalInfo(..._args: unknown[]): void {};
  const warn = function originalWarn(..._args: unknown[]): void {};
  const error = function originalError(..._args: unknown[]): void {};
  const debug = function originalDebug(..._args: unknown[]): void {};
  const trace = function originalTrace(..._args: unknown[]): void {};

  const fakeFetch = (() =>
    Promise.resolve({
      status: 200,
      statusText: "OK",
      headers: {
        get: () => "application/json",
        forEach: (cb: (value: string, key: string) => void) => {
          cb("application/json", "content-type");
        },
      },
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

  function FakeWebSocket(this: unknown): void {}
  (FakeWebSocket as unknown as Record<string, unknown>).CONNECTING = 0;
  (FakeWebSocket as unknown as Record<string, unknown>).OPEN = 1;
  (FakeWebSocket as unknown as Record<string, unknown>).CLOSING = 2;
  (FakeWebSocket as unknown as Record<string, unknown>).CLOSED = 3;

  return {
    console: { log, info, warn, error, debug, trace } as unknown as Console,
    fetch: fakeFetch,
    XMLHttpRequest: FakeXHR as unknown as typeof XMLHttpRequest,
    WebSocket: FakeWebSocket as unknown as typeof WebSocket,
    localStorage: makeFakeStorage({ theme: "dark" }),
    sessionStorage: makeFakeStorage({ cart: "1" }),
    document: { cookie: "sid=xyz" },
    location: { href: "https://example.test/page" },
    performance: { now: () => 1000 },
  };
}

describe("startInstantReplayEvidence", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("buffers console and network entries for collect", async () => {
    const scope = makeFakeScope();
    const recorder = startInstantReplayEvidence(scope, { windowMs: 60_000 });

    scope.console.log("hello-ir");
    await scope.fetch!("https://api.example.com/items");

    const first = recorder.collect();
    expect(first.console.some((e) => e.message?.includes("hello-ir"))).toBe(true);
    expect(first.network.some((e) => e.url.includes("api.example.com/items"))).toBe(true);
    expect(first.storage.length).toBeGreaterThanOrEqual(1);
    expect(first.storage.some((s) => s.phase === "start")).toBe(true);
    expect(first.storage.some((s) => s.phase === "stop")).toBe(true);

    // Collect is non-destructive.
    const second = recorder.collect();
    expect(second.console.length).toBe(first.console.length);
    expect(second.network.length).toBe(first.network.length);

    recorder.stop();
  });

  it("omits storage when captureStorage is false", async () => {
    const scope = makeFakeScope();
    const recorder = startInstantReplayEvidence(scope, {
      windowMs: 60_000,
      captureStorage: false,
    });

    scope.console.log("no-storage");
    const bundle = recorder.collect();
    expect(bundle.storage).toEqual([]);
    expect(bundle.console.length).toBeGreaterThan(0);

    recorder.stop();
  });

  it("trims console entries outside the time window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const scope = makeFakeScope();
    const recorder = startInstantReplayEvidence(scope, { windowMs: 5_000 });

    scope.console.log("old");
    vi.setSystemTime(new Date("2026-01-01T00:00:10.000Z"));
    scope.console.log("new");

    const bundle = recorder.collect();
    const messages = bundle.console.map((e) => e.message ?? "");
    expect(messages.some((m) => m.includes("old"))).toBe(false);
    expect(messages.some((m) => m.includes("new"))).toBe(true);

    recorder.stop();
  });

  it("respects maxConsoleEntries", () => {
    const scope = makeFakeScope();
    const recorder = startInstantReplayEvidence(scope, {
      windowMs: 60_000,
      maxConsoleEntries: 3,
      captureStorage: false,
    });

    for (let i = 0; i < 10; i += 1) {
      scope.console.log(`line-${i}`);
    }

    const bundle = recorder.collect();
    expect(bundle.console.length).toBe(3);
    expect(bundle.console[0]?.message).toContain("line-7");
    expect(bundle.console[2]?.message).toContain("line-9");

    recorder.stop();
  });

  it("clear empties rings but keeps patches until stop", async () => {
    const scope = makeFakeScope();
    const originalLog = scope.console.log;
    const recorder = startInstantReplayEvidence(scope, {
      windowMs: 60_000,
      captureStorage: false,
    });

    scope.console.log("before-clear");
    expect(recorder.collect().console.length).toBeGreaterThan(0);

    recorder.clear();
    expect(recorder.collect().console).toEqual([]);

    scope.console.log("after-clear");
    expect(recorder.collect().console.some((e) => e.message?.includes("after-clear"))).toBe(true);
    expect(scope.console.log).not.toBe(originalLog);

    recorder.stop();
    expect(scope.console.log).toBe(originalLog);
  });

  it("updateWindowMs tightens retention", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const scope = makeFakeScope();
    const recorder = startInstantReplayEvidence(scope, {
      windowMs: 30_000,
      captureStorage: false,
    });

    scope.console.log("kept-under-wide-window");
    vi.setSystemTime(new Date("2026-01-01T00:00:20.000Z"));
    scope.console.log("recent");

    expect(recorder.collect().console.length).toBe(2);

    recorder.updateWindowMs(5_000);
    const after = recorder.collect();
    expect(after.console.length).toBe(1);
    expect(after.console[0]?.message).toContain("recent");

    recorder.stop();
  });
});
