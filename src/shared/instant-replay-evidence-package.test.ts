import { describe, expect, it, vi } from "vitest";
import { buildInstantReplayPackageArtifacts } from "./instant-replay-evidence-package";
import { getPrivacyProfileSettings } from "./privacy-redaction";

describe("buildInstantReplayPackageArtifacts", () => {
  it("always includes instantReplay and omits empty evidence kinds", () => {
    const artifacts = buildInstantReplayPackageArtifacts({
      instantReplayJson: JSON.stringify({ schemaVersion: 1, frames: [] }),
      evidence: {
        console: [],
        network: [],
        websocket: [],
        storage: [],
      },
      privacySettings: getPrivacyProfileSettings("standard"),
    });
    expect(artifacts.instantReplay).toBeTruthy();
    expect(artifacts.console).toBeUndefined();
    expect(artifacts.network).toBeUndefined();
  });

  it("encodes console array and network schemaVersion 2", () => {
    const artifacts = buildInstantReplayPackageArtifacts({
      instantReplayJson: "{}",
      evidence: {
        console: [
          {
            source: "console-api",
            level: "log",
            timestamp: Date.now(),
            message: "hi",
          },
        ],
        network: [
          {
            requestId: "n1",
            url: "https://example.com/api",
            method: "GET",
            requestHeaders: null,
            postData: null,
            timestamp: 1,
            wallTime: Date.now() / 1000,
            initiator: null,
            resourceType: "fetch",
            status: 200,
            statusText: "OK",
            responseHeaders: null,
            mimeType: null,
            timing: null,
            protocol: null,
            remoteIPAddress: null,
            encodedDataLength: 0,
            error: null,
            responseBody: null,
            redirectChain: null,
          },
        ],
        websocket: [],
        storage: [
          {
            phase: "start",
            capturedAt: Date.now(),
            localStorage: [{ key: "a", value: "1" }],
            sessionStorage: [],
            cookies: [],
          },
        ],
      },
      privacySettings: getPrivacyProfileSettings("standard"),
    });

    expect(JSON.parse(artifacts.console!).length).toBe(1);
    const network = JSON.parse(artifacts.network!);
    expect(network.schemaVersion).toBe(2);
    expect(network.entries).toHaveLength(1);
    const storage = JSON.parse(artifacts.storage!);
    expect(storage.schemaVersion).toBe(1);
    expect(storage.snapshots).toHaveLength(1);
  });

  it("invokes redact hooks for network/websocket/storage before encoding", () => {
    const network = vi.fn((entry) => ({
      ...entry,
      url: "https://redacted.example/api",
    }));
    const websocket = vi.fn((entry) => ({ ...entry, url: "wss://redacted" }));
    const storage = vi.fn((snapshot) => ({
      ...snapshot,
      localStorage: [{ key: "token", value: "[REDACTED]", redacted: true }],
    }));

    const artifacts = buildInstantReplayPackageArtifacts({
      instantReplayJson: "{}",
      evidence: {
        console: [],
        network: [
          {
            requestId: "n1",
            url: "https://secret.example/api?token=abc",
            method: "GET",
            requestHeaders: { authorization: "Bearer secret" },
            postData: null,
            timestamp: 1,
            wallTime: Date.now() / 1000,
            initiator: null,
            resourceType: "fetch",
            status: 200,
            statusText: "OK",
            responseHeaders: null,
            mimeType: null,
            timing: null,
            protocol: null,
            remoteIPAddress: null,
            encodedDataLength: 0,
            error: null,
            responseBody: null,
            redirectChain: null,
          },
        ],
        websocket: [
          {
            requestId: "ws1",
            url: "wss://secret.example/socket",
            frames: [],
            closed: false,
          },
        ],
        storage: [
          {
            phase: "stop",
            capturedAt: Date.now(),
            localStorage: [{ key: "token", value: "raw-secret" }],
            sessionStorage: [],
            cookies: [],
          },
        ],
      },
      privacySettings: getPrivacyProfileSettings("strict"),
      redact: { network, websocket, storage },
    });

    expect(network).toHaveBeenCalledOnce();
    expect(websocket).toHaveBeenCalledOnce();
    expect(storage).toHaveBeenCalledOnce();
    expect(JSON.parse(artifacts.network!).entries[0].url).toBe("https://redacted.example/api");
    expect(JSON.parse(artifacts.websocket!)[0].url).toBe("wss://redacted");
    expect(JSON.parse(artifacts.storage!).snapshots[0].localStorage[0].value).toBe("[REDACTED]");
  });

  it("redacts sensitive console values via privacy settings", () => {
    const artifacts = buildInstantReplayPackageArtifacts({
      instantReplayJson: "{}",
      evidence: {
        console: [
          {
            source: "console-api",
            level: "log",
            timestamp: Date.now(),
            message: "password=super-secret-value",
            args: [
              {
                type: "string",
                value: "password=super-secret-value",
                description: "password=super-secret-value",
              },
            ],
          },
        ],
        network: [],
        websocket: [],
        storage: [],
      },
      privacySettings: {
        ...getPrivacyProfileSettings("strict"),
        redactConsoleValues: true,
      },
    });

    const encoded = artifacts.console!;
    expect(encoded).not.toContain("super-secret-value");
    expect(JSON.parse(encoded)).toHaveLength(1);
  });
});
