/**
 * Mock-backed unit tests for the in-memory {@link StorageManager} artifact buffer.
 *
 * These exercise the console/network/WebSocket entry handling paths (capture
 * settings, byte-limit truncation, stack policy, finalize serialization, and
 * source-map enrichment dispatch) to lift coverage above the configured floor.
 * The global Chrome mock is installed per test via `test/setup.ts`; StorageManager
 * itself is pure in-memory state, so these tests focus on its public API.
 *
 * _Requirements: 4.1, 6.3_
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPrivacyProfileSettings } from "../shared/privacy-redaction";
import type { ConsoleEntry, NetworkEntry, WebSocketEntry } from "../types/recording";
import { SourceMapResolver } from "./sourcemap-resolver";
import { StorageManager } from "./storage-manager";

function makeConsoleEntry(overrides?: Partial<ConsoleEntry>): ConsoleEntry {
  return {
    source: "console-api",
    level: "log",
    timestamp: 1000,
    message: "hello world",
    ...overrides,
  };
}

function makeNetworkEntry(overrides?: Partial<NetworkEntry>): NetworkEntry {
  return {
    requestId: "req-1",
    url: "https://example.com/api",
    method: "GET",
    requestHeaders: { accept: "application/json" },
    postData: null,
    timestamp: 10,
    wallTime: 1700000000,
    initiator: null,
    resourceType: "fetch",
    status: 200,
    statusText: "OK",
    responseHeaders: { "content-type": "application/json" },
    mimeType: "application/json",
    timing: null,
    protocol: "h2",
    remoteIPAddress: "203.0.113.1",
    encodedDataLength: 128,
    error: null,
    responseBody: null,
    redirectChain: null,
    ...overrides,
  };
}

function makeWebSocketEntry(overrides?: Partial<WebSocketEntry>): WebSocketEntry {
  return {
    requestId: "ws-1",
    url: "wss://example.com/socket",
    frames: [{ direction: "sent", timestamp: 1, opcode: 1, payloadData: "ping" }],
    closed: false,
    ...overrides,
  };
}

describe("StorageManager", () => {
  let manager: StorageManager;

  beforeEach(() => {
    manager = new StorageManager();
    manager.beginSession();
  });

  describe("session lifecycle", () => {
    it("starts with empty console and network counts", () => {
      expect(manager.getConsoleLogCount()).toBe(0);
      expect(manager.getNetworkEntryCount()).toBe(0);
    });

    it("clear() resets all buffered entries", () => {
      manager.addConsoleEntry(makeConsoleEntry());
      manager.addNetworkEntry(makeNetworkEntry());
      manager.addWebSocketEntry(makeWebSocketEntry());

      manager.clear();

      expect(manager.getConsoleLogCount()).toBe(0);
      expect(manager.getNetworkEntryCount()).toBe(0);
    });

    it("beginSession() discards previously buffered entries", () => {
      manager.addConsoleEntry(makeConsoleEntry());
      manager.beginSession();
      expect(manager.getConsoleLogCount()).toBe(0);
    });

    it("rolling window drops console/network older than N ms", () => {
      // Use wall-clock now: add paths trim against Date.now() automatically.
      const now = Date.now();
      manager.setRollingWindowMs(30_000);

      manager.addConsoleEntry(makeConsoleEntry({ timestamp: now - 45_000, message: "old" }));
      manager.addConsoleEntry(makeConsoleEntry({ timestamp: now - 5_000, message: "fresh" }));
      manager.addNetworkEntry(
        makeNetworkEntry({
          requestId: "old-net",
          wallTime: (now - 40_000) / 1000,
          timestamp: (now - 40_000) / 1000,
        }),
      );
      manager.addNetworkEntry(
        makeNetworkEntry({
          requestId: "new-net",
          wallTime: (now - 2_000) / 1000,
          timestamp: (now - 2_000) / 1000,
        }),
      );

      const finalized = manager.finalizeCurrentSession();
      expect(finalized.consoleLogCount).toBe(1);
      expect(finalized.networkRequestCount).toBe(1);
      expect(finalized.consoleLogs).toContain("fresh");
      expect(finalized.consoleLogs).not.toContain('"message":"old"');
      expect(finalized.networkRequests).toContain("new-net");
      expect(finalized.networkRequests).not.toContain("old-net");
    });

    it("clearing rolling window retains the full session", () => {
      const now = Date.now();
      manager.setRollingWindowMs(10_000);
      manager.addConsoleEntry(makeConsoleEntry({ timestamp: now - 20_000 }));
      expect(manager.getConsoleLogCount()).toBe(0);
      manager.setRollingWindowMs(null);
      manager.addConsoleEntry(makeConsoleEntry({ timestamp: now - 20_000, message: "kept" }));
      expect(manager.getConsoleLogCount()).toBe(1);
    });

    it("drops open WebSocket entries with no frames left in the window", () => {
      const now = Date.now();
      manager.setRollingWindowMs(30_000);
      manager.addWebSocketEntry(
        makeWebSocketEntry({
          requestId: "stale-open",
          closed: false,
          frames: [{ direction: "sent", timestamp: now - 60_000, opcode: 1, payloadData: "old" }],
        }),
      );
      manager.addWebSocketEntry(
        makeWebSocketEntry({
          requestId: "fresh",
          closed: false,
          frames: [{ direction: "sent", timestamp: now - 5_000, opcode: 1, payloadData: "new" }],
        }),
      );
      manager.trimToRollingWindow(now);
      const finalized = manager.finalizeCurrentSession();
      expect(finalized.webSocketLogs).toContain("fresh");
      expect(finalized.webSocketLogs).not.toContain("stale-open");
    });
  });

  describe("addConsoleEntry", () => {
    it("buffers console entries and increments the count", () => {
      manager.addConsoleEntry(makeConsoleEntry());
      manager.addConsoleEntry(makeConsoleEntry({ message: "second" }));
      expect(manager.getConsoleLogCount()).toBe(2);
    });

    it("truncates a message that exceeds maxConsoleEntryBytes", () => {
      manager.setCaptureSettings({ maxConsoleEntryBytes: 5, captureConsoleArgs: true });
      const entry = makeConsoleEntry({ message: "abcdefghij", args: undefined });
      manager.addConsoleEntry(entry);

      expect(entry.message).toContain("...(truncated)");
      expect(entry.message?.startsWith("abcde")).toBe(true);
    });

    it("truncates args that exceed maxConsoleEntryBytes", () => {
      manager.setCaptureSettings({ maxConsoleEntryBytes: 4 });
      const entry = makeConsoleEntry({
        message: undefined,
        args: [{ type: "string", value: "a very long argument value" }],
      });
      manager.addConsoleEntry(entry);

      expect(entry.args).toHaveLength(1);
      expect(entry.args?.[0].type).toBe("string");
      expect(String(entry.args?.[0].value)).toContain("...(truncated)");
    });

    it("formats args into a message string when captureConsoleArgs is disabled", () => {
      manager.setCaptureSettings({ captureConsoleArgs: false });
      const entry = makeConsoleEntry({
        message: undefined,
        args: [
          { type: "string", value: "count" },
          { type: "number", value: 42 },
        ],
      });
      manager.addConsoleEntry(entry);

      expect(entry.args).toBeUndefined();
      expect(entry.message).toBe("count 42");
    });

    it("drops the stack trace for non-error levels when stacks are limited to errors", () => {
      manager.setCaptureSettings({ captureConsoleStacks: "errors" });
      const entry = makeConsoleEntry({
        level: "log",
        stackTrace: [
          { functionName: "f", url: "https://x/app.js", lineNumber: 1, columnNumber: 0 },
        ],
      });
      manager.addConsoleEntry(entry);
      expect(entry.stackTrace).toBeUndefined();
    });

    it("keeps the stack trace for error levels", () => {
      manager.setCaptureSettings({ captureConsoleStacks: "errors" });
      const frame = { functionName: "f", url: "https://x/app.js", lineNumber: 1, columnNumber: 0 };
      const entry = makeConsoleEntry({ level: "error", stackTrace: [frame] });
      manager.addConsoleEntry(entry);
      expect(entry.stackTrace).toEqual([frame]);
    });
  });

  describe("network and websocket entries", () => {
    it("buffers network entries and increments the count", () => {
      manager.addNetworkEntry(makeNetworkEntry());
      manager.addNetworkEntry(makeNetworkEntry({ requestId: "req-2" }));
      expect(manager.getNetworkEntryCount()).toBe(2);
    });

    it("buffers websocket entries without affecting console/network counts", () => {
      manager.addWebSocketEntry(makeWebSocketEntry());
      expect(manager.getConsoleLogCount()).toBe(0);
      expect(manager.getNetworkEntryCount()).toBe(0);
    });
  });

  describe("finalizeCurrentSession", () => {
    it("returns undefined artifact strings and zero counts for an empty session", () => {
      const artifacts = manager.finalizeCurrentSession();
      expect(artifacts.consoleLogCount).toBe(0);
      expect(artifacts.networkRequestCount).toBe(0);
      expect(artifacts.consoleLogs).toBeUndefined();
      expect(artifacts.networkRequests).toBeUndefined();
      expect(artifacts.webSocketLogs).toBeUndefined();
    });

    it("serializes buffered artifacts and reports accurate counts", () => {
      manager.addConsoleEntry(makeConsoleEntry({ message: "logged" }));
      manager.addNetworkEntry(makeNetworkEntry());
      manager.addWebSocketEntry(makeWebSocketEntry());

      const artifacts = manager.finalizeCurrentSession();

      expect(artifacts.consoleLogCount).toBe(1);
      expect(artifacts.networkRequestCount).toBe(1);
      expect(artifacts.consoleLogs).toContain("logged");

      const network = JSON.parse(artifacts.networkRequests as string);
      expect(network.schemaVersion).toBe(2);
      expect(network.entries).toHaveLength(1);
      expect(network.entries[0].url).toBe("https://example.com/api");

      const sockets = JSON.parse(artifacts.webSocketLogs as string);
      expect(sockets).toHaveLength(1);
    });

    it("resets the session after finalizing", () => {
      manager.addConsoleEntry(makeConsoleEntry());
      manager.finalizeCurrentSession();
      expect(manager.getConsoleLogCount()).toBe(0);
      expect(manager.getNetworkEntryCount()).toBe(0);
    });

    it("invokes the redaction-hit recorder for each console entry under privacy settings", () => {
      const recordHits = vi.fn();
      manager.setPrivacySettings(getPrivacyProfileSettings("strict"), recordHits);
      manager.addConsoleEntry(makeConsoleEntry({ message: "first" }));
      manager.addConsoleEntry(makeConsoleEntry({ message: "second" }));

      manager.finalizeCurrentSession();

      expect(recordHits).toHaveBeenCalledTimes(2);
    });

    it("omits empty network fields from the compacted entry", () => {
      manager.addNetworkEntry(
        makeNetworkEntry({
          status: null,
          statusText: null,
          responseHeaders: null,
          error: null,
        }),
      );
      const artifacts = manager.finalizeCurrentSession();
      const entry = JSON.parse(artifacts.networkRequests as string).entries[0];
      expect(entry).not.toHaveProperty("status");
      expect(entry).not.toHaveProperty("statusText");
      expect(entry).not.toHaveProperty("error");
      expect(entry.url).toBe("https://example.com/api");
    });
  });

  describe("resolveSourceMaps", () => {
    it("does not throw when no maps are registered", () => {
      manager.addConsoleEntry(
        makeConsoleEntry({ url: "https://x/app.js", lineNumber: 5, columnNumber: 2 }),
      );
      manager.addNetworkEntry(
        makeNetworkEntry({
          initiator: { type: "script", url: "https://x/app.js", lineNumber: 3, columnNumber: 1 },
        }),
      );
      manager.addWebSocketEntry(
        makeWebSocketEntry({
          initiator: { type: "script", url: "https://x/ws.js", lineNumber: 2, columnNumber: 0 },
        }),
      );

      const resolver = new SourceMapResolver();
      expect(() => manager.resolveSourceMaps(resolver)).not.toThrow();
    });

    it("marks a console location as unresolved when a diagnostic exists but no map resolves", () => {
      const entry = makeConsoleEntry({
        url: "https://x/app.js",
        lineNumber: 5,
        columnNumber: 2,
      });
      manager.addConsoleEntry(entry);

      const resolver = new SourceMapResolver();
      manager.resolveSourceMaps(resolver, [
        {
          generatedUrl: "https://x/app.js",
          sourceMapUrl: "https://x/app.js.map",
          sourceType: "external",
          targetType: "script",
          status: "failed",
          reason: "http-error",
          httpStatusCode: 404,
        },
      ]);

      expect(entry.sourceMapStatus).toEqual({
        status: "unresolved",
        reason: "http-error",
        sourceMapUrl: "https://x/app.js.map",
        httpStatusCode: 404,
      });
    });
  });
});
