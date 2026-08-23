/**
 * iOS Safari runtime — the one runtime with no media host at all. These tests
 * focus on what makes it different from every other runtime: `mediaKind` is
 * "none", `start()` never returns a first frame, and — unlike Firefox/macOS
 * Safari, which drop in-page network entries because WebRequestNetworkCollector
 * owns them — this runtime is the sole network owner and must write them.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPrivacyProfileSettings } from "../../../packages/replay-core/src/redact/privacy-redaction";
import type { UploadSettingsStore } from "../../background/settings-store";
import { DEFAULT_CAPTURE_PRIVACY_SETTINGS } from "../../background/settings-store";
import type { StorageManager } from "../../background/storage-manager";

const { order, attachResult, MockCollectorSet, collectorSetInstances } = vi.hoisted(() => {
  const order: string[] = [];
  const attachResult: { ok: boolean; capabilities: string[]; limitations: string[] } = {
    ok: true,
    capabilities: ["console", "network"],
    limitations: [],
  };

  class MockCollectorSet {
    attach = vi.fn(async () => {
      order.push("evidence.attach");
      return attachResult;
    });
    beginSession = vi.fn(async () => {
      order.push("evidence.beginSession");
      return { limitations: [] };
    });
    detach = vi.fn(async () => {
      order.push("evidence.detach");
      return { limitations: [] };
    });
    reattach = vi.fn(async () => {
      order.push("evidence.reattach");
    });

    constructor() {
      collectorSetInstances.push(this);
    }
  }
  const collectorSetInstances: MockCollectorSet[] = [];

  return { order, attachResult, MockCollectorSet, collectorSetInstances };
});

vi.mock("../evidence/collector-set", () => ({ CollectorSet: MockCollectorSet }));
vi.mock("../evidence/in-page-collector", () => ({ InPageEvidenceCollector: vi.fn() }));

import { SafariIosRecordingRuntime } from "./safari-ios-runtime";

function fakeStorage(): StorageManager {
  return {
    setCaptureSettings: vi.fn(),
    setPrivacySettings: vi.fn(),
    addConsoleEntry: vi.fn(),
    addNetworkEntry: vi.fn(),
    upsertWebSocketEntry: vi.fn(),
    setStorageSnapshot: vi.fn(),
  } as unknown as StorageManager;
}

function fakeSettings(overrides: Partial<UploadSettingsStore> = {}): UploadSettingsStore {
  return {
    activeStorageProvider: "google-drive",
    folderInput: "/gn-tracing",
    folderId: null,
    folderPath: [],
    folderByProvider: {},
    zipPassword: "",
    ...DEFAULT_CAPTURE_PRIVACY_SETTINGS,
    ...overrides,
  } as UploadSettingsStore;
}

function startInput(overrides: Partial<Parameters<SafariIosRecordingRuntime["start"]>[0]> = {}) {
  return {
    tabId: 1,
    sessionId: "s-1",
    settings: fakeSettings(),
    privacySettings: getPrivacyProfileSettings("custom"),
    onRedactionHits: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  order.length = 0;
  collectorSetInstances.length = 0;
  attachResult.ok = true;
  attachResult.capabilities = ["console", "network"];
  attachResult.limitations = [];
});

describe("SafariIosRecordingRuntime", () => {
  it("reports mediaKind as none", () => {
    const runtime = new SafariIosRecordingRuntime(fakeStorage());
    expect(runtime.mediaKind).toBe("none");
  });

  it("start never produces a first frame (there is no video path)", async () => {
    const runtime = new SafariIosRecordingRuntime(fakeStorage());
    const result = await runtime.start(startInput());
    expect(result).toEqual({ firstFrameAt: null });
    expect(order).toEqual(["evidence.attach", "evidence.beginSession"]);
  });

  it("throws when the sole evidence collector failed to attach", async () => {
    attachResult.ok = false;
    attachResult.capabilities = [];
    attachResult.limitations = ["in-page blocked by CSP"];

    const runtime = new SafariIosRecordingRuntime(fakeStorage());
    await expect(runtime.start(startInput())).rejects.toThrow("in-page blocked by CSP");
  });

  it("stopMedia and closeMediaHostIfIdle are no-ops (no media host to control)", async () => {
    const runtime = new SafariIosRecordingRuntime(fakeStorage());
    await expect(runtime.stopMedia()).resolves.toBeUndefined();
    await expect(runtime.closeMediaHostIfIdle()).resolves.toBeUndefined();
  });

  it("ingestEvidenceEntry writes network entries: it is the sole network owner", async () => {
    const storage = fakeStorage();
    const runtime = new SafariIosRecordingRuntime(storage);
    await runtime.start(startInput({ sessionId: "s-1" }));

    runtime.ingestEvidenceEntry("s-1", "network", { timestamp: 1 } as never);
    expect(storage.addNetworkEntry).toHaveBeenCalledWith({ timestamp: 1 });
  });

  it("routes console, websocket, and storage entries to StorageManager", async () => {
    const storage = fakeStorage();
    const runtime = new SafariIosRecordingRuntime(storage);
    await runtime.start(startInput({ sessionId: "s-1" }));

    runtime.ingestEvidenceEntry("s-1", "console", { timestamp: 1 } as never);
    runtime.ingestEvidenceEntry("s-1", "websocket", { timestamp: 2 } as never);
    runtime.ingestEvidenceEntry("s-1", "storage", { timestamp: 3 } as never);

    expect(storage.addConsoleEntry).toHaveBeenCalledWith({ timestamp: 1 });
    expect(storage.upsertWebSocketEntry).toHaveBeenCalledWith({ timestamp: 2 });
    expect(storage.setStorageSnapshot).toHaveBeenCalledWith({ timestamp: 3 });
  });

  it("ignores entries from a session that is no longer active", async () => {
    const storage = fakeStorage();
    const runtime = new SafariIosRecordingRuntime(storage);
    await runtime.start(startInput({ sessionId: "s-1" }));

    runtime.ingestEvidenceEntry("stale-session", "console", { timestamp: 1 } as never);
    expect(storage.addConsoleEntry).not.toHaveBeenCalled();
  });

  it("finalizeEvidence always surfaces the no-video limitation", async () => {
    const runtime = new SafariIosRecordingRuntime(fakeStorage());
    await runtime.start(startInput());

    const result = await runtime.finalizeEvidence({
      captureStorage: true,
      captureDomSnapshots: true,
      stopTime: 1,
    });
    expect(result.sourceMapDiagnostics).toBeNull();
    expect(result.privacyLimitations).toContain(
      "Video is not available on iOS/iPadOS Safari. This recording captures " +
        "console, network metadata, and interaction events only.",
    );
  });
});
