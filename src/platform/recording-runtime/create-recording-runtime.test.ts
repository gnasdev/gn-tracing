/**
 * Recording runtime selection: Firefox must not construct CdpManager.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../../background/cdp-manager", () => {
  return {
    CdpManager: vi.fn(function MockCdpManager(this: { tag: string }) {
      this.tag = "cdp";
    }),
  };
});

vi.mock("../media/offscreen-host", () => ({
  OffscreenMediaHost: class {
    kind = "offscreen";
    activeSessionId = null;
    startCapture = vi.fn();
    stopCapture = vi.fn();
    onRecordingComplete = vi.fn();
    clearActiveSession = vi.fn();
    hydrateActiveSession = vi.fn();
    ensurePackagingContext = vi.fn();
    cleanup = vi.fn();
  },
}));

vi.mock("../media/page-host", () => ({
  ExtensionPageMediaHost: class {
    kind = "extension-page";
    activeSessionId = null;
    startCapture = vi.fn();
    stopCapture = vi.fn();
    onRecordingComplete = vi.fn();
    clearActiveSession = vi.fn();
    hydrateActiveSession = vi.fn();
    ensurePackagingContext = vi.fn();
    cleanup = vi.fn();
  },
}));

import { CdpManager } from "../../background/cdp-manager";
import type { StorageManager } from "../../background/storage-manager";
import { ChromiumRecordingRuntime } from "./chromium-runtime";
import { createRecordingRuntime } from "./create-recording-runtime";
import { FirefoxRecordingRuntime } from "./firefox-runtime";
import { SafariIosRecordingRuntime } from "./safari-ios-runtime";
import { SafariRecordingRuntime } from "./safari-runtime";

function fakeStorage(): StorageManager {
  return {
    setCaptureSettings: vi.fn(),
    setPrivacySettings: vi.fn(),
    addConsoleEntry: vi.fn(),
    addNetworkEntry: vi.fn(),
    upsertWebSocketEntry: vi.fn(),
    setStorageSnapshot: vi.fn(),
    resolveSourceMaps: vi.fn(),
  } as unknown as StorageManager;
}

describe("createRecordingRuntime", () => {
  it("chrome target constructs Chromium runtime and CdpManager", () => {
    vi.mocked(CdpManager).mockClear();
    const runtime = createRecordingRuntime(fakeStorage(), "chrome");
    expect(runtime).toBeInstanceOf(ChromiumRecordingRuntime);
    expect(runtime.mediaKind).toBe("offscreen");
    expect(CdpManager).toHaveBeenCalledTimes(1);
    // Always present; no-op on Chromium.
    expect(typeof runtime.ingestEvidenceEntry).toBe("function");
    runtime.ingestEvidenceEntry("s", "console", { timestamp: 1 } as never);
  });

  it("chrome target uses Chromium runtime", () => {
    vi.mocked(CdpManager).mockClear();
    const runtime = createRecordingRuntime(fakeStorage(), "chrome");
    expect(runtime).toBeInstanceOf(ChromiumRecordingRuntime);
    expect(CdpManager).toHaveBeenCalledTimes(1);
  });

  it("edge and opera targets use Chromium runtime", () => {
    for (const target of ["edge", "opera"] as const) {
      vi.mocked(CdpManager).mockClear();
      const runtime = createRecordingRuntime(fakeStorage(), target);
      expect(runtime).toBeInstanceOf(ChromiumRecordingRuntime);
      expect(runtime.mediaKind).toBe("offscreen");
      expect(CdpManager).toHaveBeenCalledTimes(1);
    }
  });

  it("firefox target never constructs CdpManager", () => {
    vi.mocked(CdpManager).mockClear();
    const runtime = createRecordingRuntime(fakeStorage(), "firefox");
    expect(runtime).toBeInstanceOf(FirefoxRecordingRuntime);
    expect(runtime.mediaKind).toBe("extension-page");
    expect(CdpManager).not.toHaveBeenCalled();
  });

  it("safari target never constructs CdpManager", () => {
    vi.mocked(CdpManager).mockClear();
    const runtime = createRecordingRuntime(fakeStorage(), "safari");
    expect(runtime).toBeInstanceOf(SafariRecordingRuntime);
    expect(runtime.mediaKind).toBe("extension-page");
    expect(CdpManager).not.toHaveBeenCalled();
  });

  it("safari-ios target never constructs CdpManager and has no media host", () => {
    vi.mocked(CdpManager).mockClear();
    const runtime = createRecordingRuntime(fakeStorage(), "safari-ios");
    expect(runtime).toBeInstanceOf(SafariIosRecordingRuntime);
    expect(runtime.mediaKind).toBe("none");
    expect(CdpManager).not.toHaveBeenCalled();
  });
});
