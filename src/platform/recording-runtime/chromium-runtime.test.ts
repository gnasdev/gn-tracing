/**
 * Chromium runtime orchestration order.
 *
 * `CollectorSet` and `CdpManager` are mocked so these tests assert only what
 * `ChromiumRecordingRuntime` itself is responsible for: the sequencing between
 * media capture, evidence collection, and source-map cleanup documented as
 * comments in `chromium-runtime.ts` — not the behavior of the collectors
 * themselves, which have their own tests.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPrivacyProfileSettings } from "../../../packages/replay-core/src/redact/privacy-redaction";
import type { UploadSettingsStore } from "../../background/settings-store";
import { DEFAULT_CAPTURE_PRIVACY_SETTINGS } from "../../background/settings-store";
import type { StorageManager } from "../../background/storage-manager";

// `vi.mock` factories are hoisted above every other statement in this file, so
// anything they reference (the mock classes, and the shared `order` array the
// tests inspect) must be created through `vi.hoisted` — a plain top-level
// `class`/`const` here would still throw "before initialization" at mock time.
const {
  order,
  MockCollectorSet,
  collectorSetInstances,
  MockCdpManager,
  cdpInstances,
  MockOffscreenMediaHost,
  mediaHostInstances,
} = vi.hoisted(() => {
  const order: string[] = [];

  class MockCollectorSet {
    evidenceCoverage = {
      schemaVersion: 1,
      surfaces: {
        "storage-snapshot": { source: "cdp", quality: "full" },
        "dom-snapshot": { source: "cdp", quality: "full" },
        "console-api": { source: "cdp", quality: "full" },
      },
    };
    attach = vi.fn(async () => {
      order.push("evidence.attach");
      return {
        ok: true,
        capabilities: ["console", "network"],
        limitations: [] as string[],
      };
    });
    beginSession = vi.fn(async () => {
      order.push("evidence.beginSession");
      return { limitations: [] };
    });
    detach = vi.fn(async () => {
      order.push("evidence.detach");
      return { limitations: [] };
    });

    constructor() {
      collectorSetInstances.push(this);
    }
  }
  const collectorSetInstances: MockCollectorSet[] = [];

  class MockCdpManager {
    setCaptureSettings = vi.fn();
    setPrivacySettings = vi.fn();
    flushSourceMaps = vi.fn(async () => {
      order.push("cdp.flushSourceMaps");
    });
    captureStorageSnapshot = vi.fn(async (phase: string) => {
      order.push(`cdp.captureStorageSnapshot(${phase})`);
    });
    captureDomSnapshot = vi.fn(async (label: string) => {
      order.push(`cdp.captureDomSnapshot(${label})`);
    });
    getSourceMapDiagnostics = vi.fn().mockReturnValue([]);
    releaseSourceMaps = vi.fn(() => {
      order.push("cdp.releaseSourceMaps");
    });
    sourceMapResolver = { tag: "resolver" };

    constructor() {
      cdpInstances.push(this);
    }
  }
  const cdpInstances: MockCdpManager[] = [];

  class MockOffscreenMediaHost {
    activeSessionId: string | null = null;
    startCapture = vi.fn(async () => {
      order.push("media.startCapture");
      return 42;
    });
    stopCapture = vi.fn(async () => {
      order.push("media.stopCapture");
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
  const mediaHostInstances: MockOffscreenMediaHost[] = [];

  return {
    order,
    MockCollectorSet,
    collectorSetInstances,
    MockCdpManager,
    cdpInstances,
    MockOffscreenMediaHost,
    mediaHostInstances,
  };
});

vi.mock("../evidence/collector-set", () => ({ CollectorSet: MockCollectorSet }));
vi.mock("../evidence/cdp-collector", () => ({ CdpEvidenceCollector: vi.fn() }));
vi.mock("../../background/cdp-manager", () => ({ CdpManager: MockCdpManager }));
vi.mock("../media/offscreen-host", () => ({ OffscreenMediaHost: MockOffscreenMediaHost }));

import { ChromiumRecordingRuntime } from "./chromium-runtime";

function fakeStorage(): StorageManager {
  return { resolveSourceMaps: vi.fn() } as unknown as StorageManager;
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

function startInput(
  overrides: Partial<Parameters<InstanceType<typeof ChromiumRecordingRuntime>["start"]>[0]> = {},
) {
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
  cdpInstances.length = 0;
  mediaHostInstances.length = 0;
});

describe("ChromiumRecordingRuntime.start", () => {
  it("starts media capture before attaching evidence collectors", async () => {
    const runtime = new ChromiumRecordingRuntime(fakeStorage());
    await runtime.start(startInput());

    // Documented in chromium-runtime.ts: "Media first. Parallel CDP attach
    // during getUserMedia stamps evidence before video t=0."
    expect(order.slice(0, 3)).toEqual([
      "media.startCapture",
      "evidence.attach",
      "evidence.beginSession",
    ]);
  });

  it("captures storage and DOM snapshots only when the settings ask for them", async () => {
    const runtime = new ChromiumRecordingRuntime(fakeStorage());
    await runtime.start(
      startInput({ settings: fakeSettings({ captureStorage: false, captureDomSnapshots: false }) }),
    );
    expect(order).not.toContain("cdp.captureStorageSnapshot(start)");
    expect(order).not.toContain("cdp.captureDomSnapshot(start)");

    order.length = 0;
    const runtime2 = new ChromiumRecordingRuntime(fakeStorage());
    await runtime2.start(
      startInput({ settings: fakeSettings({ captureStorage: true, captureDomSnapshots: true }) }),
    );
    expect(order).toContain("cdp.captureStorageSnapshot(start)");
    expect(order).toContain("cdp.captureDomSnapshot(start)");
  });

  it("fails before starting a session when Chrome cannot attach CDP", async () => {
    const runtime = new ChromiumRecordingRuntime(fakeStorage());
    const collectors = collectorSetInstances.at(-1);
    collectors?.attach.mockResolvedValueOnce({
      ok: false,
      capabilities: [],
      limitations: ["cdp could not start: Another debugger is already attached to the tab."],
    });

    const start = runtime.start(startInput());
    await expect(start).rejects.toThrow(/Chrome could not start debugging this tab/);
    await expect(start).rejects.toThrow(/Another debugger is already attached/);
    expect(collectors?.beginSession).not.toHaveBeenCalled();
    expect(mediaHostInstances.at(-1)?.hydrateActiveSession).not.toHaveBeenCalled();
  });

  it("hydrates the active session last, once media and evidence are both live", async () => {
    const runtime = new ChromiumRecordingRuntime(fakeStorage());
    await runtime.start(startInput());
    expect(order.at(-1)).toBe("media.hydrateActiveSession");
  });
});

describe("ChromiumRecordingRuntime.finalizeEvidence", () => {
  it("flushes source maps before taking stop-time snapshots, then detaches evidence", async () => {
    const runtime = new ChromiumRecordingRuntime(fakeStorage());
    await runtime.start(startInput());
    order.length = 0;

    await runtime.finalizeEvidence({
      captureStorage: true,
      captureDomSnapshots: true,
      stopTime: 1,
    });

    expect(order).toEqual([
      "cdp.flushSourceMaps",
      "cdp.captureStorageSnapshot(stop)",
      "cdp.captureDomSnapshot(stop)",
      "evidence.detach",
      "cdp.releaseSourceMaps",
    ]);
  });

  it("passes the CDP source-map resolver and diagnostics to storage", async () => {
    const storage = fakeStorage();
    const runtime = new ChromiumRecordingRuntime(storage);
    await runtime.start(startInput());
    const cdp = cdpInstances.at(-1);
    cdp?.getSourceMapDiagnostics.mockReturnValue([{ url: "app.js.map" }]);

    const result = await runtime.finalizeEvidence({
      captureStorage: false,
      captureDomSnapshots: false,
      stopTime: 1_700_000_000_000,
    });

    expect(storage.resolveSourceMaps).toHaveBeenCalledWith(cdp?.sourceMapResolver, [
      { url: "app.js.map" },
    ]);
    expect(result.sourceMapDiagnostics).toMatchObject({
      schemaVersion: 1,
      sourceMaps: [{ url: "app.js.map" }],
    });
  });

  it("reports no diagnostics artifact when no source maps were resolved", async () => {
    const runtime = new ChromiumRecordingRuntime(fakeStorage());
    await runtime.start(startInput());

    const result = await runtime.finalizeEvidence({
      captureStorage: false,
      captureDomSnapshots: false,
      stopTime: 1,
    });
    expect(result.sourceMapDiagnostics).toBeNull();
  });
});

describe("ChromiumRecordingRuntime.discard", () => {
  it("stops media and detaches evidence even when one of them rejects", async () => {
    const runtime = new ChromiumRecordingRuntime(fakeStorage());
    await runtime.start(startInput());
    const media = mediaHostInstances.at(-1);
    const collectors = collectorSetInstances.at(-1);
    media?.stopCapture.mockRejectedValueOnce(new Error("stopCapture failed"));

    // Promise.allSettled means the media rejection must not stop evidence.detach
    // (and vice versa) or leave discard() itself throwing.
    await expect(runtime.discard()).resolves.toBeUndefined();
    expect(collectors?.detach).toHaveBeenCalledTimes(1);
    expect(media?.cleanup).toHaveBeenCalledTimes(1);
  });
});

describe("ChromiumRecordingRuntime evidence bridging", () => {
  it("ingestEvidenceEntry and reinjectEvidenceCapture are no-ops (CDP owns evidence directly)", async () => {
    const runtime = new ChromiumRecordingRuntime(fakeStorage());
    // Must not throw, and must not reach into StorageManager: CDP writes
    // evidence itself, so these bridge hooks exist only to satisfy the shared
    // RecordingRuntime interface (see the doc comment on the interface).
    expect(() =>
      runtime.ingestEvidenceEntry("s-1", "console", { timestamp: 1 } as never),
    ).not.toThrow();
    await expect(runtime.reinjectEvidenceCapture(1, "s-1")).resolves.toBeUndefined();
  });
});

describe("ChromiumRecordingRuntime finalized coverage", () => {
  it("omits disabled storage and DOM surfaces from package coverage", async () => {
    const runtime = new ChromiumRecordingRuntime(fakeStorage());
    await runtime.start(startInput());

    const result = await runtime.finalizeEvidence({
      captureStorage: false,
      captureDomSnapshots: false,
      stopTime: 1,
    });

    expect(result.evidenceCoverage?.surfaces).toEqual({
      "console-api": { source: "cdp", quality: "full" },
    });
  });
});
