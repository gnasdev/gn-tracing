/**
 * Firefox full-record network ownership: webRequest stores rows; in-page
 * network posts are not dual-written.
 *
 * Drives the real FirefoxRecordingRuntime.ingestEvidenceEntry and the real
 * WebRequestNetworkCollector completed path (not reimplementations).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { installChromeMock, resetChromeMock } from "../../../test/mocks/chrome";
import { StorageManager } from "../../background/storage-manager";
import type { NetworkEntry } from "../../types/recording";
import { WebRequestNetworkCollector } from "../evidence/web-request/collector";
import { FirefoxRecordingRuntime } from "./firefox-runtime";

function emit(event: unknown, ...args: unknown[]): void {
  for (const listener of (event as { listeners: Array<(...a: unknown[]) => unknown> }).listeners) {
    listener(...args);
  }
}

function makeNetworkEntry(overrides: Partial<NetworkEntry> = {}): NetworkEntry {
  return {
    requestId: "page-1",
    url: "https://example.com/api",
    method: "GET",
    requestHeaders: null,
    postData: null,
    timestamp: 1,
    wallTime: 1,
    initiator: null,
    resourceType: "XHR",
    status: 200,
    statusText: "OK",
    responseHeaders: null,
    mimeType: "application/json",
    timing: null,
    protocol: null,
    remoteIPAddress: null,
    encodedDataLength: 0,
    error: null,
    responseBody: { body: '{"secret":true}', base64Encoded: false },
    redirectChain: null,
    servedFromCache: false,
    ...overrides,
  };
}

describe("Firefox full-record network ownership", () => {
  beforeEach(() => {
    resetChromeMock(installChromeMock());
  });

  it("ingestEvidenceEntry drops kind network so in-page cannot dual-write", () => {
    const storage = new StorageManager();
    storage.beginSession();
    const runtime = new FirefoxRecordingRuntime(storage);

    // When #sessionId is null the stale-session guard is inactive and ingest runs.
    runtime.ingestEvidenceEntry("s1", "network", makeNetworkEntry());
    expect(storage.getNetworkEntryCount()).toBe(0);

    runtime.ingestEvidenceEntry("s1", "console", {
      timestamp: 1,
      level: "log",
      message: "hi",
      args: [],
      source: "console-api",
      url: null,
      lineNumber: null,
      stackTrace: null,
    } as never);
    expect(storage.getConsoleLogCount()).toBe(1);
  });

  it("webRequest completed path stores exactly one NetworkEntry with null body", async () => {
    const storage = new StorageManager();
    storage.beginSession();
    const collector = new WebRequestNetworkCollector(storage);
    await collector.attach({ tabId: 3, sessionId: "s1" });
    await collector.beginSession({ tabId: 3, sessionId: "s1" });

    emit(chrome.webRequest.onBeforeRequest, {
      requestId: "wr-1",
      url: "https://example.com/doc",
      method: "GET",
      type: "main_frame",
      timeStamp: 1000,
      frameId: 0,
      tabId: 3,
    });
    emit(chrome.webRequest.onCompleted, {
      requestId: "wr-1",
      statusCode: 200,
      statusLine: "HTTP/1.1 200 OK",
      tabId: 3,
    });

    expect(storage.getNetworkEntryCount()).toBe(1);

    // Second path via spy to assert null body on the stored entry.
    const storage2 = new StorageManager();
    storage2.beginSession();
    const entries: NetworkEntry[] = [];
    const originalAdd = storage2.addNetworkEntry.bind(storage2);
    storage2.addNetworkEntry = (entry: NetworkEntry) => {
      entries.push(entry);
      originalAdd(entry);
    };
    const collector2 = new WebRequestNetworkCollector(storage2);
    await collector2.attach({ tabId: 3, sessionId: "s1" });
    await collector2.beginSession({ tabId: 3, sessionId: "s1" });
    emit(chrome.webRequest.onBeforeRequest, {
      requestId: "wr-2",
      url: "https://example.com/doc",
      method: "GET",
      type: "main_frame",
      timeStamp: 1000,
      frameId: 0,
      tabId: 3,
    });
    emit(chrome.webRequest.onCompleted, {
      requestId: "wr-2",
      statusCode: 200,
      tabId: 3,
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.requestId).toBe("wr-2");
    expect(entries[0]?.responseBody).toBeNull();
    expect(entries[0]?.status).toBe(200);
  });

  it("discard detaches evidence collectors without throwing", async () => {
    const storage = new StorageManager();
    const runtime = new FirefoxRecordingRuntime(storage);
    await expect(runtime.discard()).resolves.toBeUndefined();
  });
});
