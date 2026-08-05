/**
 * In-page evidence redaction adapter — drives the real shared helpers.
 */
import { describe, expect, it } from "vitest";
import type { NetworkEntry, StorageSnapshot, WebSocketEntry } from "../types/recording";
import {
  redactInPageNetworkEntry,
  redactInPageStorageSnapshot,
  redactInPageWebSocketEntry,
} from "./in-page-evidence-redaction";
import { getPrivacyProfileSettings } from "./privacy-redaction";

const settings = getPrivacyProfileSettings("standard");

function networkEntry(overrides: Partial<NetworkEntry> = {}): NetworkEntry {
  return {
    requestId: "1",
    url: "https://user:secret@example.com/api?token=abc123def",
    method: "POST",
    requestHeaders: { Authorization: "Bearer abc", "Content-Type": "application/json" },
    postData: JSON.stringify({ password: "hunter2", name: "ada" }),
    timestamp: 1,
    wallTime: 1,
    initiator: null,
    resourceType: "XHR",
    status: 200,
    statusText: "OK",
    responseHeaders: { "Set-Cookie": "sid=1" },
    mimeType: "application/json",
    timing: null,
    protocol: null,
    remoteIPAddress: null,
    encodedDataLength: 0,
    error: null,
    responseBody: null,
    redirectChain: null,
    servedFromCache: false,
    ...overrides,
  };
}

describe("redactInPageNetworkEntry", () => {
  it("redacts URL credentials, sensitive headers, and body fields via shared policy", () => {
    const hits: unknown[] = [];
    const entry = redactInPageNetworkEntry(networkEntry(), settings, (h) => {
      if (h) hits.push(...h);
    });
    expect(entry.url).not.toContain("secret");
    expect(entry.url).not.toMatch(/token=abc123def/);
    expect(entry.requestHeaders?.Authorization).toMatch(/redacted/i);
    expect(entry.postData || "").not.toContain("hunter2");
    expect(hits.length).toBeGreaterThan(0);
  });
});

describe("redactInPageWebSocketEntry", () => {
  it("redacts websocket URL and sensitive-field payloads", () => {
    const entry: WebSocketEntry = {
      requestId: "ws-1",
      url: "wss://example.com/socket?token=supersecretvalue",
      closed: false,
      frames: [
        {
          direction: "received",
          opcode: 1,
          payloadData: '{"password":"hunter2"}',
          timestamp: 1,
        },
      ],
    };
    const redacted = redactInPageWebSocketEntry(entry, settings);
    expect(redacted.url).not.toContain("supersecretvalue");
    expect(redacted.frames[0]?.payloadData || "").not.toContain("hunter2");
  });
});

describe("redactInPageStorageSnapshot", () => {
  it("redacts storage values when enabled", () => {
    const snapshot: StorageSnapshot = {
      phase: "stop",
      capturedAt: 1,
      localStorage: [{ key: "password", value: "hunter2", redacted: false }],
      sessionStorage: [],
      cookies: [
        {
          name: "token",
          value: "abc",
          domain: "example.com",
          path: "/",
          redacted: false,
        },
      ],
    };
    const redacted = redactInPageStorageSnapshot(snapshot, settings, { redactStorageValues: true });
    expect(redacted.localStorage[0]?.value).not.toBe("hunter2");
    expect(redacted.cookies[0]?.value).not.toBe("abc");
  });

  it("skips when redactStorageValues is false", () => {
    const snapshot: StorageSnapshot = {
      phase: "stop",
      capturedAt: 1,
      localStorage: [{ key: "password", value: "hunter2", redacted: false }],
      sessionStorage: [],
      cookies: [],
    };
    const redacted = redactInPageStorageSnapshot(snapshot, settings, {
      redactStorageValues: false,
    });
    expect(redacted.localStorage[0]?.value).toBe("hunter2");
  });
});
