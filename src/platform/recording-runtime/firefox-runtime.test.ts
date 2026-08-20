/**
 * Firefox runtime orchestration order — focused on what differs from
 * `ChromiumRecordingRuntime` (see `chromium-runtime.test.ts`): evidence attaches
 * before media starts (not after), `reinjectEvidenceCapture` actually re-arms
 * collectors instead of being a no-op, and there is no source-map diagnostics
 * artifact. `CollectorSet` and the media host are mocked so these tests assert
 * only what `FirefoxRecordingRuntime` itself is responsible for.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPrivacyProfileSettings } from "../../../packages/replay-core/src/redact/privacy-redaction";
import type { UploadSettingsStore } from "../../background/settings-store";
import { DEFAULT_CAPTURE_PRIVACY_SETTINGS } from "../../background/settings-store";
import type { StorageManager } from "../../background/storage-manager";

// See chromium-runtime.test.ts for why this needs `vi.hoisted`: `vi.mock`
// factories are hoisted above every other statement in the file.
const {
  order,
  attachResult,
  MockCollectorSet,
  collectorSetInstances,
  MockExtensionPageMediaHost,
  mediaHostInstances,
} = vi.hoisted(() => {
  const order: string[] = [];
  // Mutable so a test can force a total-attach-failure without needing a
  // constructor argument the mock's `new CollectorSet(...)` call site doesn't
  // pass. Reset to this default in `beforeEach`.
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

import { FirefoxRecordingRuntime } from "./firefox-runtime";

function fakeStorage(): StorageManager {
  return {
    setCaptureSettings: vi.fn(),
    setPrivacySettings: vi.fn(),
    addConsoleEntry: vi.fn(),
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

function startInput(overrides: Partial<Parameters<FirefoxRecordingRuntime["start"]>[0]> = {}) {
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

describe("FirefoxRecordingRuntime.start", () => {
  it("attaches evidence collectors before starting media capture", async () => {
    const runtime = new FirefoxRecordingRuntime(fakeStorage());
    await runtime.start(startInput());

    // Documented in firefox-runtime.ts: "Prepare while the tab still holds
    // activeTab. A legacy getDisplayMedia fallback focuses the media host and
    // revokes activeTab, so attach first." The opposite order from Chromium.
    expect(order.slice(0, 3)).toEqual([
      "evidence.attach",
      "media.startCapture",
      "evidence.beginSession",
    ]);
  });

  it("throws when every evidence collector failed to attach", async () => {
    attachResult.ok = false;
    attachResult.capabilities = [];
    attachResult.limitations = ["in-page blocked by CSP", "webRequest permission missing"];

    const runtime = new FirefoxRecordingRuntime(fakeStorage());
    await expect(runtime.start(startInput())).rejects.toThrow("in-page blocked by CSP");
    expect(collectorSetInstances.at(-1)?.attach).toHaveBeenCalledTimes(1);
  });

  it("restores the recorded tab's focus unless media was already prearmed", async () => {
    const runtime = new FirefoxRecordingRuntime(fakeStorage());
    await runtime.start(startInput({ mediaPrearmed: false }));
    expect(mediaHostInstances.at(-1)?.restoreRecordedTabFocus).toHaveBeenCalledTimes(1);

    order.length = 0;
    const runtime2 = new FirefoxRecordingRuntime(fakeStorage());
    await runtime2.start(startInput({ mediaPrearmed: true }));
    expect(mediaHostInstances.at(-1)?.restoreRecordedTabFocus).not.toHaveBeenCalled();
  });

  it("hydrates the active session last", async () => {
    const runtime = new FirefoxRecordingRuntime(fakeStorage());
    await runtime.start(startInput());
    expect(order.at(-1)).toBe("media.hydrateActiveSession");
  });
});

describe("FirefoxRecordingRuntime.reinjectEvidenceCapture", () => {
  it("re-arms collectors after a navigation, unlike the Chromium runtime's no-op", async () => {
    const runtime = new FirefoxRecordingRuntime(fakeStorage());
    await runtime.start(startInput({ sessionId: "s-1" }));
    const collectors = collectorSetInstances.at(-1);

    await runtime.reinjectEvidenceCapture(1, "s-1");
    expect(collectors?.reattach).toHaveBeenCalledWith(1, "s-1");
  });

  it("ignores a re-inject call for a session that is no longer active", async () => {
    const runtime = new FirefoxRecordingRuntime(fakeStorage());
    await runtime.start(startInput({ sessionId: "s-1" }));
    const collectors = collectorSetInstances.at(-1);

    await runtime.reinjectEvidenceCapture(1, "stale-session");
    expect(collectors?.reattach).not.toHaveBeenCalled();
  });
});

describe("FirefoxRecordingRuntime.ingestEvidenceEntry", () => {
  it("routes console, websocket, and storage entries to StorageManager", async () => {
    const storage = fakeStorage();
    const runtime = new FirefoxRecordingRuntime(storage);
    await runtime.start(startInput({ sessionId: "s-1" }));

    runtime.ingestEvidenceEntry("s-1", "console", { timestamp: 1 } as never);
    runtime.ingestEvidenceEntry("s-1", "websocket", { timestamp: 2 } as never);
    runtime.ingestEvidenceEntry("s-1", "storage", { timestamp: 3 } as never);

    expect(storage.addConsoleEntry).toHaveBeenCalledWith({ timestamp: 1 });
    expect(storage.upsertWebSocketEntry).toHaveBeenCalledWith({ timestamp: 2 });
    expect(storage.setStorageSnapshot).toHaveBeenCalledWith({ timestamp: 3 });
  });

  it("drops network entries: WebRequestNetworkCollector is the single owner", async () => {
    const storage = fakeStorage();
    const runtime = new FirefoxRecordingRuntime(storage);
    await runtime.start(startInput({ sessionId: "s-1" }));

    runtime.ingestEvidenceEntry("s-1", "network", { timestamp: 1 } as never);

    expect(storage.addConsoleEntry).not.toHaveBeenCalled();
    expect(storage.upsertWebSocketEntry).not.toHaveBeenCalled();
    expect(storage.setStorageSnapshot).not.toHaveBeenCalled();
  });

  it("ignores entries from a session that is no longer active", async () => {
    const storage = fakeStorage();
    const runtime = new FirefoxRecordingRuntime(storage);
    await runtime.start(startInput({ sessionId: "s-1" }));

    runtime.ingestEvidenceEntry("stale-session", "console", { timestamp: 1 } as never);
    expect(storage.addConsoleEntry).not.toHaveBeenCalled();
  });
});

describe("FirefoxRecordingRuntime.finalizeEvidence", () => {
  it("never produces source-map diagnostics: there is no CDP on Firefox", async () => {
    const runtime = new FirefoxRecordingRuntime(fakeStorage());
    await runtime.start(startInput());

    const result = await runtime.finalizeEvidence({
      captureStorage: true,
      captureDomSnapshots: true,
      stopTime: 1,
    });
    expect(result.sourceMapDiagnostics).toBeNull();
  });

  it("detaches evidence and clears the session id", async () => {
    const runtime = new FirefoxRecordingRuntime(fakeStorage());
    await runtime.start(startInput({ sessionId: "s-1" }));
    const collectors = collectorSetInstances.at(-1);
    order.length = 0;

    await runtime.finalizeEvidence({
      captureStorage: false,
      captureDomSnapshots: false,
      stopTime: 1,
    });
    expect(order).toEqual(["evidence.detach"]);

    // The session id is cleared as part of finalize, so a stray in-page message
    // arriving afterward (already-detached collectors racing the last flush)
    // must not be attributed to it.
    runtime.ingestEvidenceEntry("s-1", "console", { timestamp: 1 } as never);
    expect(collectors?.detach).toHaveBeenCalledTimes(1);
  });
});

describe("FirefoxRecordingRuntime.closeMediaHostIfIdle", () => {
  it("keeps the capture window open (no-op), unlike Chromium tearing down offscreen", async () => {
    const runtime = new FirefoxRecordingRuntime(fakeStorage());
    await runtime.start(startInput());
    const media = mediaHostInstances.at(-1);

    await runtime.closeMediaHostIfIdle();
    expect(media?.cleanup).not.toHaveBeenCalled();
  });
});
