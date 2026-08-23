/**
 * Safari (macOS) runtime orchestration — mirrors firefox-runtime.test.ts since
 * SafariRecordingRuntime composes the same collectors/media host in the same
 * order. Only asserts what would regress if the two classes drifted apart.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPrivacyProfileSettings } from "../../../packages/replay-core/src/redact/privacy-redaction";
import type { UploadSettingsStore } from "../../background/settings-store";
import { DEFAULT_CAPTURE_PRIVACY_SETTINGS } from "../../background/settings-store";
import type { StorageManager } from "../../background/storage-manager";

const {
  order,
  attachResult,
  MockCollectorSet,
  collectorSetInstances,
  MockExtensionPageMediaHost,
  mediaHostInstances,
} = vi.hoisted(() => {
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

  class MockExtensionPageMediaHost {
    activeSessionId: string | null = null;
    capturedSurface: { label?: string; displaySurface?: string } = { displaySurface: "browser" };
    startCapture = vi.fn(async () => {
      order.push("media.startCapture");
      return 42;
    });
    stopCapture = vi.fn(async () => {
      order.push("media.stopCapture");
    });
    restoreRecordedTabFocus = vi.fn(async () => {
      order.push("media.restoreRecordedTabFocus");
    });
    onRecordingComplete = vi.fn();
    clearActiveSession = vi.fn();
    hydrateActiveSession = vi.fn(() => {
      order.push("media.hydrateActiveSession");
    });
    ensurePackagingContext = vi.fn().mockResolvedValue(undefined);
    cleanup = vi.fn(async () => {
      order.push("media.cleanup");
    });

    constructor() {
      mediaHostInstances.push(this);
    }
  }
  const mediaHostInstances: MockExtensionPageMediaHost[] = [];

  return {
    order,
    attachResult,
    MockCollectorSet,
    collectorSetInstances,
    MockExtensionPageMediaHost,
    mediaHostInstances,
  };
});

vi.mock("../evidence/collector-set", () => ({ CollectorSet: MockCollectorSet }));
vi.mock("../evidence/in-page-collector", () => ({ InPageEvidenceCollector: vi.fn() }));
vi.mock("../evidence/web-request/collector", () => ({ WebRequestNetworkCollector: vi.fn() }));
vi.mock("../media/page-host", () => ({ ExtensionPageMediaHost: MockExtensionPageMediaHost }));

import { SafariRecordingRuntime } from "./safari-runtime";

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

function startInput(overrides: Partial<Parameters<SafariRecordingRuntime["start"]>[0]> = {}) {
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
  mediaHostInstances.length = 0;
  attachResult.ok = true;
  attachResult.capabilities = ["console", "network"];
  attachResult.limitations = [];
});

describe("SafariRecordingRuntime.start", () => {
  it("attaches evidence collectors before starting media capture, same order as Firefox", async () => {
    const runtime = new SafariRecordingRuntime(fakeStorage());
    await runtime.start(startInput());

    expect(order.slice(0, 3)).toEqual([
      "evidence.attach",
      "media.startCapture",
      "evidence.beginSession",
    ]);
  });

  it("reports mediaKind as extension-page", () => {
    const runtime = new SafariRecordingRuntime(fakeStorage());
    expect(runtime.mediaKind).toBe("extension-page");
  });

  it("throws when every evidence collector failed to attach", async () => {
    attachResult.ok = false;
    attachResult.capabilities = [];
    attachResult.limitations = ["in-page blocked by CSP"];

    const runtime = new SafariRecordingRuntime(fakeStorage());
    await expect(runtime.start(startInput())).rejects.toThrow("in-page blocked by CSP");
  });
});

describe("SafariRecordingRuntime.ingestEvidenceEntry", () => {
  it("drops network entries: WebRequestNetworkCollector is the single owner", async () => {
    const storage = fakeStorage();
    const runtime = new SafariRecordingRuntime(storage);
    await runtime.start(startInput({ sessionId: "s-1" }));

    runtime.ingestEvidenceEntry("s-1", "network", { timestamp: 1 } as never);
    expect(storage.addNetworkEntry).not.toHaveBeenCalled();
  });

  it("routes console and websocket entries to StorageManager", async () => {
    const storage = fakeStorage();
    const runtime = new SafariRecordingRuntime(storage);
    await runtime.start(startInput({ sessionId: "s-1" }));

    runtime.ingestEvidenceEntry("s-1", "console", { timestamp: 1 } as never);
    runtime.ingestEvidenceEntry("s-1", "websocket", { timestamp: 2 } as never);

    expect(storage.addConsoleEntry).toHaveBeenCalledWith({ timestamp: 1 });
    expect(storage.upsertWebSocketEntry).toHaveBeenCalledWith({ timestamp: 2 });
  });
});

describe("SafariRecordingRuntime.finalizeEvidence", () => {
  it("never produces source-map diagnostics: there is no CDP on Safari", async () => {
    const runtime = new SafariRecordingRuntime(fakeStorage());
    await runtime.start(startInput());

    const result = await runtime.finalizeEvidence({
      captureStorage: true,
      captureDomSnapshots: true,
      stopTime: 1,
    });
    expect(result.sourceMapDiagnostics).toBeNull();
  });
});
