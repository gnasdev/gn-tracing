/**
 * WebRequestNetworkCollector against the shared chrome mock, driven by
 * firing the mock's webRequest events the way the real browser would.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock, resetChromeMock } from "../../../../test/mocks/chrome";
import { StorageManager } from "../../../background/storage-manager";
import { WebRequestNetworkCollector } from "./collector";

function emit(event: unknown, ...args: unknown[]): void {
  for (const listener of (event as { listeners: Array<(...a: unknown[]) => unknown> }).listeners) {
    listener(...args);
  }
}

describe("WebRequestNetworkCollector", () => {
  beforeEach(() => {
    resetChromeMock(installChromeMock());
  });

  it("attaches successfully and reports the network capability plus the body-gap limitation", async () => {
    const storage = new StorageManager();
    const collector = new WebRequestNetworkCollector(storage);

    const result = await collector.attach({ tabId: 7, sessionId: "s1" });

    expect(result.ok).toBe(true);
    expect(result.capabilities).toEqual(["network"]);
    expect(result.limitations[0]).toMatch(/response bodies are not captured/i);
  });

  it("only records traffic from the attached tab", async () => {
    const storage = new StorageManager();
    vi.spyOn(storage, "addNetworkEntry");
    const collector = new WebRequestNetworkCollector(storage);
    await collector.attach({ tabId: 7, sessionId: "s1" });

    emit(chrome.webRequest.onBeforeRequest, {
      requestId: "1",
      url: "https://example.com/a",
      method: "GET",
      type: "xmlhttprequest",
      timeStamp: 0,
      frameId: 0,
      tabId: 999, // a different tab
    });
    emit(chrome.webRequest.onCompleted, { requestId: "1", statusCode: 200, tabId: 999 });

    expect(storage.addNetworkEntry).not.toHaveBeenCalled();
  });

  it("writes a completed request from the attached tab into storage", async () => {
    const storage = new StorageManager();
    vi.spyOn(storage, "addNetworkEntry");
    const collector = new WebRequestNetworkCollector(storage);
    await collector.attach({ tabId: 7, sessionId: "s1" });

    emit(chrome.webRequest.onBeforeRequest, {
      requestId: "1",
      url: "https://example.com/a",
      method: "GET",
      type: "xmlhttprequest",
      timeStamp: 0,
      frameId: 0,
      tabId: 7,
    });
    emit(chrome.webRequest.onCompleted, { requestId: "1", statusCode: 200, tabId: 7 });

    expect(storage.addNetworkEntry).toHaveBeenCalledTimes(1);
    expect(storage.addNetworkEntry).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "1", status: 200 }),
    );
  });

  it("flushes requests still in flight at detach as incomplete rows", async () => {
    const storage = new StorageManager();
    vi.spyOn(storage, "addNetworkEntry");
    const collector = new WebRequestNetworkCollector(storage);
    await collector.attach({ tabId: 7, sessionId: "s1" });

    emit(chrome.webRequest.onBeforeRequest, {
      requestId: "1",
      url: "https://example.com/slow",
      method: "GET",
      type: "image",
      timeStamp: 0,
      frameId: 0,
      tabId: 7,
    });

    await collector.detach();

    expect(storage.addNetworkEntry).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "1", status: null }),
    );
  });

  it("does not re-register listeners on a second attach", async () => {
    const storage = new StorageManager();
    const collector = new WebRequestNetworkCollector(storage);

    await collector.attach({ tabId: 7, sessionId: "s1" });
    await collector.detach();
    await collector.attach({ tabId: 8, sessionId: "s2" });

    // Five events (before/send-headers/headers-received/completed/error), one
    // listener each — never more, however many times attach() runs.
    expect(
      (chrome.webRequest.onBeforeRequest as unknown as { listeners: unknown[] }).listeners,
    ).toHaveLength(1);
    expect(
      (chrome.webRequest.onCompleted as unknown as { listeners: unknown[] }).listeners,
    ).toHaveLength(1);
  });

  it("reports failure and no capability when webRequest is unavailable", async () => {
    // Real Chrome never throws for a missing optional-permission namespace —
    // chrome.webRequest is simply undefined while still being an existing key,
    // which is exactly what an optional permission that was never granted
    // looks like. The guarded mock's Proxy allows this: `"webRequest" in obj`
    // stays true, so the property reads as undefined without tripping the
    // "not mocked" guard that catches genuine typos.
    const chromeMock = chrome as unknown as { webRequest: unknown };
    const original = chromeMock.webRequest;
    chromeMock.webRequest = undefined;
    try {
      const storage = new StorageManager();
      const collector = new WebRequestNetworkCollector(storage);
      const result = await collector.attach({ tabId: 7, sessionId: "s1" });

      expect(result.ok).toBe(false);
      expect(result.capabilities).toEqual([]);
      expect(result.limitations[0]).toMatch(/webRequest permission/i);
    } finally {
      chromeMock.webRequest = original;
    }
  });
});
