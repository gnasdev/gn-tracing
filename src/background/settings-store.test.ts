/**
 * Mock-backed unit tests for the background settings store.
 *
 * These tests exercise the load/persist paths of `getUploadSettings` and
 * `saveUploadSettings` against the shared in-memory Chrome mock installed on
 * `globalThis.chrome` by `test/setup.ts`. They cover:
 *
 * - reading persisted settings out of `chrome.storage.local`,
 * - the `chrome.storage.session` popup-state fallback (and the local backfill),
 * - default/empty behaviour when nothing is stored, and
 * - persisting settings (asserting both the spy call and the resulting state).
 *
 * The module caches loaded settings at module scope, so each test resets the
 * module registry and imports a fresh copy to observe the storage interaction
 * from a clean slate.
 *
 * _Requirements: 4.1, 6.3_
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChromeMock } from "../../test/mocks/chrome";
import { STORAGE_KEY_STATE } from "./settings-store";

/** The local-storage key the settings store reads/writes (kept in sync with the module). */
const STORAGE_KEY_SETTINGS = "gn_tracing_upload_settings";

/** Access the freshly installed mock with its spy/store internals exposed. */
function mockChrome(): ChromeMock {
  return globalThis.chrome as unknown as ChromeMock;
}

/** Import a fresh copy of the module so its module-scoped cache is reset per test. */
async function importStore() {
  return import("./settings-store");
}

beforeEach(() => {
  // Drop the cached module instance so `hasLoadedUploadSettings` starts false and
  // each test observes a genuine read against the freshly installed Chrome mock.
  vi.resetModules();
});

describe("getUploadSettings", () => {
  it("returns persisted settings from local storage", async () => {
    await mockChrome().storage.local.set({
      [STORAGE_KEY_SETTINGS]: { captureProfile: "lean", zipPassword: "secret" },
    });

    const { getUploadSettings } = await importStore();
    const settings = await getUploadSettings();

    expect(settings.captureProfile).toBe("lean");
    expect(settings.zipPassword).toBe("secret");
    // Stored captureProfile drives profile-derived defaults (lean disables request bodies).
    expect(settings.captureRequestBodies).toBe(false);
    expect(mockChrome().storage.local.get.callCount).toBe(1);
  });

  it("returns normalized defaults when nothing is stored", async () => {
    const { getUploadSettings } = await importStore();
    const settings = await getUploadSettings();

    expect(settings.captureProfile).toBe("full");
    expect(settings.folderInput).toBe("/gn-tracing");
    expect(settings.zipPassword).toBe("");
    expect(settings.activeStorageProvider).toBe("google-drive");
    // The "full" profile enables request/response body capture by default.
    expect(settings.captureRequestBodies).toBe(true);
    expect(settings.captureResponseBodies).toBe(true);
  });

  it("falls back to session popup state and backfills local storage", async () => {
    await mockChrome().storage.session.set({
      [STORAGE_KEY_STATE]: { settings: { captureProfile: "lean", zipPassword: "from-session" } },
    });

    const { getUploadSettings } = await importStore();
    const settings = await getUploadSettings();

    expect(settings.captureProfile).toBe("lean");
    expect(settings.zipPassword).toBe("from-session");

    // The session-derived settings are written back to local storage.
    const local = mockChrome().storage.local;
    expect(local.set.callCount).toBe(1);
    expect(local.set.calls[0]?.args[0]).toEqual({ [STORAGE_KEY_SETTINGS]: settings });
    expect(local.store[STORAGE_KEY_SETTINGS]).toEqual(settings);
  });

  it("returns the cached value on subsequent calls without re-reading storage", async () => {
    const { getUploadSettings } = await importStore();
    await getUploadSettings();
    await getUploadSettings();

    // The second call is served from the in-memory cache, so storage is read once.
    expect(mockChrome().storage.local.get.callCount).toBe(1);
  });

  it("falls back to defaults when local storage rejects", async () => {
    mockChrome().storage.local.get.mockImplementation(() =>
      Promise.reject(new Error("storage unavailable")),
    );

    const { getUploadSettings } = await importStore();
    const settings = await getUploadSettings();

    expect(settings.captureProfile).toBe("full");
    expect(settings.folderInput).toBe("/gn-tracing");
  });
});

describe("saveUploadSettings", () => {
  it("persists settings to local storage and caches them", async () => {
    const { getUploadSettings, saveUploadSettings } = await importStore();
    const defaults = await getUploadSettings();
    const updated = { ...defaults, zipPassword: "new-password", captureProfile: "lean" as const };

    await saveUploadSettings(updated);

    const local = mockChrome().storage.local;
    const setCall = local.set.calls.at(-1);
    expect(setCall?.args[0]).toEqual({ [STORAGE_KEY_SETTINGS]: updated });
    expect(local.store[STORAGE_KEY_SETTINGS]).toEqual(updated);

    // A follow-up read is served from the cache populated by the save.
    const getCallCountBefore = local.get.callCount;
    const reloaded = await getUploadSettings();
    expect(reloaded).toEqual(updated);
    expect(local.get.callCount).toBe(getCallCountBefore);
  });
});

describe("loadPersistedPopupState", () => {
  it("returns the persisted popup state from session storage", async () => {
    const persisted = {
      recording: null,
      sessions: [],
      googleDrive: { isConnected: false },
      settings: { captureProfile: "lean" },
      uploadHistory: [],
    };
    await mockChrome().storage.session.set({ [STORAGE_KEY_STATE]: persisted });

    const { loadPersistedPopupState } = await importStore();
    const state = await loadPersistedPopupState();

    expect(state).toEqual(persisted);
  });

  it("returns null when no popup state is stored", async () => {
    const { loadPersistedPopupState } = await importStore();
    expect(await loadPersistedPopupState()).toBeNull();
  });

  it("returns null when session storage rejects", async () => {
    mockChrome().storage.session.get.mockImplementation(() =>
      Promise.reject(new Error("session unavailable")),
    );

    const { loadPersistedPopupState } = await importStore();
    expect(await loadPersistedPopupState()).toBeNull();
  });
});

describe("normalizeRecordingUrl", () => {
  it("rewrites chrome-extension player URLs to namespaced external URLs", async () => {
    const { normalizeRecordingUrl } = await importStore();
    const rewritten = normalizeRecordingUrl(
      "chrome-extension://abcdef/player/player.html?id=driveFile99",
    );
    expect(rewritten).toContain("/gdrive/driveFile99");
  });

  it("rewrites localhost player URLs to namespaced external URLs", async () => {
    const { normalizeRecordingUrl } = await importStore();
    const rewritten = normalizeRecordingUrl("http://localhost:5176/?id=localFile1");
    expect(rewritten).toContain("/gdrive/localFile1");
  });

  it("leaves production bare Drive URLs unchanged (legacy history)", async () => {
    const { normalizeRecordingUrl } = await importStore();
    const bare = "https://tracing.gnas.dev/1AbCdEfGhIjKlMnOp";
    expect(normalizeRecordingUrl(bare)).toBe(bare);
  });

  it("leaves production namespaced URLs unchanged", async () => {
    const { normalizeRecordingUrl } = await importStore();
    const namespaced = "https://tracing.gnas.dev/gdrive/1AbCdEfGhIjKlMnOp";
    expect(normalizeRecordingUrl(namespaced)).toBe(namespaced);
  });
});

describe("activeStorageProvider clamp", () => {
  it("accepts dropbox on load (P1 registered)", async () => {
    await mockChrome().storage.local.set({
      [STORAGE_KEY_SETTINGS]: { activeStorageProvider: "dropbox" },
    });

    const { getUploadSettings } = await importStore();
    const settings = await getUploadSettings();
    expect(settings.activeStorageProvider).toBe("dropbox");
  });

  it("clamps legacy onedrive to google-drive (removed provider)", async () => {
    await mockChrome().storage.local.set({
      [STORAGE_KEY_SETTINGS]: { activeStorageProvider: "onedrive" },
    });

    const { getUploadSettings } = await importStore();
    const settings = await getUploadSettings();
    expect(settings.activeStorageProvider).toBe("google-drive");
  });

  it("keeps separate folder paths per provider", async () => {
    await mockChrome().storage.local.set({
      [STORAGE_KEY_SETTINGS]: {
        activeStorageProvider: "dropbox",
        folderByProvider: {
          "google-drive": {
            folderInput: "/drive-only",
            folderId: null,
            folderPath: ["drive-only"],
          },
          dropbox: {
            folderInput: "/dropbox-only",
            folderId: null,
            folderPath: ["dropbox-only"],
          },
        },
      },
    });

    const { getUploadSettings } = await importStore();
    const settings = await getUploadSettings();
    expect(settings.activeStorageProvider).toBe("dropbox");
    expect(settings.folderInput).toBe("/dropbox-only");
    expect(settings.folderByProvider["google-drive"]?.folderInput).toBe("/drive-only");
  });
});
