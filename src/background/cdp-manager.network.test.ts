/**
 * Integration tests for CdpManager network capture against the real collector.
 *
 * Drives chrome.debugger.onEvent + sendCommand (mocked only at the I/O edge)
 * and asserts StorageManager artifacts — not a reimplementation of eligibility.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  makeCdpLoadingFailed,
  makeCdpLoadingFinished,
  makeCdpRequestWillBeSent,
  makeCdpResponseReceived,
} from "../../test/factories";
import type { ChromeMock } from "../../test/mocks/chrome";
import { CdpManager } from "./cdp-manager";
import { StorageManager } from "./storage-manager";

// The installed chrome mock (see test/setup.ts) exposes spy helpers
// (`calls`, `mockImplementation`, `emit`) that the real chrome types lack.
function chromeMock(): ChromeMock {
  return chrome as unknown as ChromeMock;
}

function parseNetworkEntries(storage: StorageManager): Array<Record<string, unknown>> {
  const artifacts = storage.finalizeCurrentSession();
  if (!artifacts.networkRequests) return [];
  const parsed = JSON.parse(artifacts.networkRequests) as {
    entries?: Array<Record<string, unknown>>;
  };
  return parsed.entries ?? [];
}

function parseWebSocketEntries(storage: StorageManager): Array<Record<string, unknown>> {
  const artifacts = storage.finalizeCurrentSession();
  if (!artifacts.webSocketLogs) return [];
  return JSON.parse(artifacts.webSocketLogs) as Array<Record<string, unknown>>;
}

describe("CdpManager network capture (shipped collector)", () => {
  let storage: StorageManager;
  let cdp: CdpManager;
  const tabId = 42;
  const debuggee = { tabId };

  beforeEach(async () => {
    storage = new StorageManager();
    storage.beginSession();
    cdp = new CdpManager(storage);
    cdp.setCaptureSettings({
      captureNetwork: true,
      captureResponseBodyMode: "eligible",
      maxResponseBodyBytes: null,
      captureRequestHeaders: "full",
      captureResponseHeaders: "full",
      captureRequestBodies: false,
      suppressRecorderInternalRequests: true,
      captureWebSockets: true,
    });

    // Domain enable / auto-attach / getResponseBody all go through sendCommand.
    chromeMock().debugger.sendCommand.mockImplementation(async (...args: unknown[]) => {
      const method = args[1] as string;
      const params = args[2] as { requestId?: string } | undefined;
      if (method === "Network.getResponseBody") {
        return {
          body: `{"id":"${params?.requestId ?? "unknown"}"}`,
          base64Encoded: false,
        };
      }
      return {};
    });

    await cdp.attach(tabId);
  });

  function emit(method: string, params: object): void {
    chromeMock().debugger.onEvent.emit(debuggee, method, params);
  }

  it("stores eligible JSON response body after loadingFinished", async () => {
    const requestId = "req-json-body";
    emit("Network.requestWillBeSent", makeCdpRequestWillBeSent({ requestId, type: "XHR" }));
    emit(
      "Network.responseReceived",
      makeCdpResponseReceived({
        requestId,
        mimeType: "application/json",
        headers: { "content-type": "application/json" },
      }),
    );
    emit("Network.loadingFinished", makeCdpLoadingFinished({ requestId, encodedDataLength: 20 }));

    // Allow the in-flight getResponseBody promise to settle, then detach.
    await cdp.detach();

    const entries = parseNetworkEntries(storage);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.url).toContain("api.example.com");
    expect(entries[0]?.responseBody).toMatchObject({
      body: `{"id":"${requestId}"}`,
      base64Encoded: false,
    });
    expect(
      chromeMock().debugger.sendCommand.calls.some((c) => c.args[1] === "Network.getResponseBody"),
    ).toBe(true);
  });

  it("uses the exception object description instead of CDP's generic text", () => {
    emit("Runtime.exceptionThrown", {
      timestamp: 1_700_000_000_000,
      exceptionDetails: {
        text: "Uncaught",
        exception: {
          type: "object",
          subtype: "error",
          className: "TypeError",
          description:
            "TypeError: Cannot read properties of undefined (reading 'total')\n    at checkEndModel (https://shop.test/checkout.js:42:17)",
        },
      },
    });

    const artifacts = storage.finalizeCurrentSession();
    const entries = JSON.parse(artifacts.consoleLogs || "[]") as Array<Record<string, unknown>>;

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      source: "exception",
      level: "error",
      message: "TypeError: Cannot read properties of undefined (reading 'total')",
    });
    expect(entries[0]?.args).toMatchObject([
      {
        subtype: "error",
        description:
          "TypeError: Cannot read properties of undefined (reading 'total')\n    at checkEndModel (https://shop.test/checkout.js:42:17)",
      },
    ]);
  });

  it("falls back to the CDP text when no exception value is available", () => {
    emit("Runtime.exceptionThrown", {
      timestamp: 1_700_000_000_000,
      exceptionDetails: { text: "Uncaught" },
    });

    const artifacts = storage.finalizeCurrentSession();
    const entries = JSON.parse(artifacts.consoleLogs || "[]") as Array<Record<string, unknown>>;

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      source: "exception",
      level: "error",
      message: "Uncaught",
    });
  });

  it("fetches body when mimeType is empty but Content-Type header is JSON", async () => {
    const requestId = "req-header-mime";
    emit("Network.requestWillBeSent", makeCdpRequestWillBeSent({ requestId }));
    emit(
      "Network.responseReceived",
      makeCdpResponseReceived({
        requestId,
        mimeType: "",
        headers: { "Content-Type": "application/problem+json; charset=utf-8" },
      }),
    );
    emit("Network.loadingFinished", makeCdpLoadingFinished({ requestId }));
    await cdp.detach();

    const entries = parseNetworkEntries(storage);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.responseBody).toMatchObject({
      body: `{"id":"${requestId}"}`,
    });
  });

  it("captures object properties for console arguments that only expose an objectId", async () => {
    chromeMock().debugger.sendCommand.mockImplementation(async (...args: unknown[]) => {
      const method = args[1] as string;
      if (method === "Runtime.getProperties") {
        return {
          result: [
            { name: "status", value: { type: "number", value: 500, description: "500" } },
            { name: "message", value: { type: "string", value: "Request failed" } },
          ],
        };
      }
      return {};
    });

    emit("Runtime.consoleAPICalled", {
      type: "error",
      timestamp: 1_700_000_000_000,
      args: [
        {
          type: "object",
          className: "HttpErrorResponse",
          description: "HttpErrorResponse",
          objectId: "remote-http-error",
        },
      ],
    });

    await cdp.detach();

    const artifacts = storage.finalizeCurrentSession();
    const entries = JSON.parse(artifacts.consoleLogs || "[]") as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.args).toMatchObject([
      {
        className: "HttpErrorResponse",
        preview: {
          properties: [
            { name: "status", type: "number", value: "500" },
            { name: "message", type: "string", value: "Request failed" },
          ],
        },
      },
    ]);
    expect(
      chromeMock().debugger.sendCommand.calls.some(
        (call) =>
          call.args[1] === "Runtime.getProperties" &&
          (call.args[2] as { objectId?: string } | undefined)?.objectId === "remote-http-error",
      ),
    ).toBe(true);
  });

  it("does not call getResponseBody when capture mode is off", async () => {
    cdp.setCaptureSettings({ captureResponseBodyMode: "off" });
    const requestId = "req-off";
    emit("Network.requestWillBeSent", makeCdpRequestWillBeSent({ requestId }));
    emit("Network.responseReceived", makeCdpResponseReceived({ requestId }));
    emit("Network.loadingFinished", makeCdpLoadingFinished({ requestId }));
    await cdp.detach();

    expect(
      chromeMock().debugger.sendCommand.calls.filter(
        (c) => c.args[1] === "Network.getResponseBody",
      ),
    ).toHaveLength(0);
    const entries = parseNetworkEntries(storage);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.responseBody).toBeUndefined();
  });

  it("skips body fetch when encoded size exceeds maxResponseBodyBytes", async () => {
    cdp.setCaptureSettings({ maxResponseBodyBytes: 10 });
    const requestId = "req-too-big";
    emit("Network.requestWillBeSent", makeCdpRequestWillBeSent({ requestId }));
    emit("Network.responseReceived", makeCdpResponseReceived({ requestId }));
    emit("Network.loadingFinished", makeCdpLoadingFinished({ requestId, encodedDataLength: 5000 }));
    await cdp.detach();

    expect(
      chromeMock().debugger.sendCommand.calls.filter(
        (c) => c.args[1] === "Network.getResponseBody",
      ),
    ).toHaveLength(0);
  });

  it("records failed requests without response body", async () => {
    const requestId = "req-failed";
    emit("Network.requestWillBeSent", makeCdpRequestWillBeSent({ requestId }));
    emit(
      "Network.loadingFailed",
      makeCdpLoadingFailed({ requestId, errorText: "net::ERR_CONNECTION_REFUSED" }),
    );
    await cdp.detach();

    const entries = parseNetworkEntries(storage);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.error).toBe("net::ERR_CONNECTION_REFUSED");
    expect(entries[0]?.responseBody).toBeUndefined();
  });

  it("waits for in-flight body fetch before chromeMock().debugger.detach", async () => {
    let releaseBody: (() => void) | undefined;
    const bodyGate = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });

    chromeMock().debugger.sendCommand.mockImplementation(async (...args: unknown[]) => {
      const method = args[1] as string;
      const params = args[2] as { requestId?: string } | undefined;
      if (method === "Network.getResponseBody") {
        await bodyGate;
        return { body: `{"late":"${params?.requestId}"}`, base64Encoded: false };
      }
      return {};
    });

    // Re-attach so the new sendCommand mock is used for body fetch only.
    await cdp.detach();
    storage.beginSession();
    await cdp.attach(tabId);
    const detachCountAfterAttach = chromeMock().debugger.detach.callCount;
    const bodyCallsBefore = chromeMock().debugger.sendCommand.calls.filter(
      (c) => c.args[1] === "Network.getResponseBody",
    ).length;

    const requestId = "req-slow-body";
    emit("Network.requestWillBeSent", makeCdpRequestWillBeSent({ requestId }));
    emit("Network.responseReceived", makeCdpResponseReceived({ requestId }));
    emit("Network.loadingFinished", makeCdpLoadingFinished({ requestId }));

    const detachPromise = cdp.detach();
    // Yield so getResponseBody starts and blocks on bodyGate.
    await Promise.resolve();
    await Promise.resolve();
    // Debugger detach must not run while the body promise is still open.
    expect(chromeMock().debugger.detach.callCount).toBe(detachCountAfterAttach);

    releaseBody?.();
    await detachPromise;

    expect(chromeMock().debugger.detach.callCount).toBe(detachCountAfterAttach + 1);
    const bodyCalls = chromeMock().debugger.sendCommand.calls.filter(
      (c) => c.args[1] === "Network.getResponseBody",
    );
    expect(bodyCalls.length).toBeGreaterThan(bodyCallsBefore);
    const lastBody = bodyCalls[bodyCalls.length - 1];
    const lastDetach =
      chromeMock().debugger.detach.calls[chromeMock().debugger.detach.calls.length - 1];
    expect(lastBody).toBeTruthy();
    expect(lastDetach).toBeTruthy();
    // Body fetch must have been ordered before the final debugger.detach.
    expect(lastBody?.order).toBeLessThan(lastDetach?.order);

    const entries = parseNetworkEntries(storage);
    expect(entries[0]?.responseBody).toMatchObject({
      body: `{"late":"${requestId}"}`,
    });
  });

  it("waits for console property capture before chromeMock().debugger.detach", async () => {
    let releaseProperties: (() => void) | undefined;
    const propertiesGate = new Promise<void>((resolve) => {
      releaseProperties = resolve;
    });
    chromeMock().debugger.sendCommand.mockImplementation(async (...args: unknown[]) => {
      if (args[1] === "Runtime.getProperties") {
        await propertiesGate;
        return {
          result: [{ name: "message", value: { type: "string", value: "late error" } }],
        };
      }
      return {};
    });

    const detachCountBefore = chromeMock().debugger.detach.callCount;
    emit("Runtime.consoleAPICalled", {
      type: "error",
      timestamp: 1_700_000_000_000,
      args: [
        {
          type: "object",
          className: "Error",
          description: "Error",
          objectId: "late-console-error",
        },
      ],
    });

    const detachPromise = cdp.detach();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(chromeMock().debugger.detach.callCount).toBe(detachCountBefore);

    releaseProperties?.();
    await detachPromise;

    expect(chromeMock().debugger.detach.callCount).toBe(detachCountBefore + 1);
    const entries = JSON.parse(storage.finalizeCurrentSession().consoleLogs || "[]") as Array<{
      args?: Array<{
        preview?: { properties?: Array<{ value?: string }> };
      }>;
    }>;
    expect(entries[0]?.args?.[0]?.preview?.properties?.[0]?.value).toBe("late error");
  });

  it("does not fetch body for binary image mime", async () => {
    const requestId = "req-img";
    emit(
      "Network.requestWillBeSent",
      makeCdpRequestWillBeSent({
        requestId,
        url: "https://cdn.example.com/a.png",
        type: "Image",
      }),
    );
    emit(
      "Network.responseReceived",
      makeCdpResponseReceived({
        requestId,
        mimeType: "image/png",
        headers: { "content-type": "image/png" },
      }),
    );
    emit("Network.loadingFinished", makeCdpLoadingFinished({ requestId, encodedDataLength: 999 }));
    await cdp.detach();

    expect(
      chromeMock().debugger.sendCommand.calls.filter(
        (c) => c.args[1] === "Network.getResponseBody",
      ),
    ).toHaveLength(0);
  });

  it("re-stamps WebSocket frames captured before the first network request", async () => {
    const requestId = "ws-backfill";
    const beforeMs = Date.now();
    const wallTimeSeconds = beforeMs / 1000;

    // WebSocket traffic starts before any HTTP request; the frame gets a
    // Date.now() fallback because the wall-clock offset is not yet known.
    emit("Network.webSocketCreated", { requestId, url: "wss://example.com/socket" });
    emit("Network.webSocketFrameSent", {
      requestId,
      timestamp: 10,
      response: { opcode: 1, payloadData: "hello" },
    });

    // The first HTTP request teaches the CDP manager the offset between
    // monotonic seconds and wall-clock epoch ms.
    emit(
      "Network.requestWillBeSent",
      makeCdpRequestWillBeSent({
        requestId: "http-anchor",
        url: "https://example.com/anchor",
        timestamp: 12,
        wallTime: wallTimeSeconds,
      }),
    );

    emit("Network.webSocketClosed", { requestId });
    await cdp.detach();

    const entries = parseWebSocketEntries(storage);
    expect(entries).toHaveLength(1);
    const frames = (entries[0]?.frames ?? []) as Array<{ timestamp: number }>;
    expect(frames).toHaveLength(1);

    // Monotonic 10 is 2 seconds before monotonic 12, so the frame should be
    // anchored 2000ms before the wall-time of the HTTP anchor request.
    const expectedEpochMs = beforeMs - 2000;
    expect(frames[0]?.timestamp).toBeGreaterThanOrEqual(expectedEpochMs - 100);
    expect(frames[0]?.timestamp).toBeLessThanOrEqual(expectedEpochMs + 100);
  });
});
