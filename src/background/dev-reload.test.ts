import { describe, expect, it, vi } from "vitest";
import {
  applyDevReloadRevision,
  createDevReloadClientStarter,
  DEV_RELOAD_REVISION_KEY,
  type DevReloadRevisionStore,
  isDevReloadSafe,
  startDevReloadClient,
} from "./dev-reload";

function createStore(initialRevision?: string): DevReloadRevisionStore {
  let value = initialRevision;
  return {
    get: vi.fn(async () => value),
    set: vi.fn(async (nextRevision: string) => {
      value = nextRevision;
    }),
  };
}

describe("applyDevReloadRevision", () => {
  it("records the initial coordinator revision without restarting the extension", async () => {
    const store = createStore();
    const reload = vi.fn();

    await expect(applyDevReloadRevision("1", { store, reload })).resolves.toBe(false);
    expect(store.set).toHaveBeenCalledWith("1");
    expect(reload).not.toHaveBeenCalled();
  });

  it("persists a newer revision before reloading exactly once", async () => {
    const store = createStore("1");
    const reload = vi.fn();

    await expect(applyDevReloadRevision("2", { store, reload })).resolves.toBe(true);
    expect(store.set).toHaveBeenCalledWith("2");
    expect(reload).toHaveBeenCalledOnce();
  });

  it("does not reload when the coordinator revision is unchanged", async () => {
    const store = createStore("2");
    const reload = vi.fn();

    await expect(applyDevReloadRevision("2", { store, reload })).resolves.toBe(false);
    expect(store.set).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("does not reload if recording begins while persisting a new revision", async () => {
    const stored = createStore("1");
    let reloadIsAllowed = true;
    const store: DevReloadRevisionStore = {
      get: stored.get,
      set: vi.fn(async (revision: string) => {
        await stored.set(revision);
        reloadIsAllowed = false;
      }),
    };
    const reload = vi.fn();

    await expect(
      applyDevReloadRevision("2", { store, reload, canReload: () => reloadIsAllowed }),
    ).resolves.toBe(false);

    expect(store.set).toHaveBeenNthCalledWith(1, "2");
    expect(store.set).toHaveBeenNthCalledWith(2, "1");
    expect(reload).not.toHaveBeenCalled();
  });

  it("defers reloads for both active and starting recording sessions", () => {
    expect(isDevReloadSafe({ isRecording: false, sessionId: null })).toBe(true);
    expect(isDevReloadSafe({ isRecording: false, sessionId: "starting-session" })).toBe(false);
    expect(isDevReloadSafe({ isRecording: true, sessionId: "active-session" })).toBe(false);
  });

  it("starts a client only once for one background-worker lifetime", () => {
    const start = vi.fn();
    const startOnce = createDevReloadClientStarter(start);

    expect(startOnce()).toBe(true);
    expect(startOnce()).toBe(false);
    expect(start).toHaveBeenCalledOnce();
  });

  it("uses a stable session storage key", () => {
    expect(DEV_RELOAD_REVISION_KEY).toBe("gn_tracing_dev_reload_revision");
  });

  it("defers a changed revision until recording is no longer active", async () => {
    vi.useFakeTimers();
    const store = createStore("1");
    const reload = vi.fn();
    let recordingIsActive = true;
    const pendingResponse = new Promise<Response>(() => {});
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ target: "chrome", revision: "2" }), { status: 200 }),
      )
      .mockReturnValue(pendingResponse) as unknown as typeof fetch;
    const stop = startDevReloadClient({
      appEnv: "development",
      browserTarget: "chrome",
      canReload: () => !recordingIsActive,
      fetchImpl,
      reload,
      reloadUrl: "http://127.0.0.1:63973",
      store,
    });

    try {
      for (let index = 0; index < 8; index += 1) {
        await Promise.resolve();
      }
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(reload).not.toHaveBeenCalled();
      expect(store.set).not.toHaveBeenCalled();

      recordingIsActive = false;
      await vi.advanceTimersByTimeAsync(750);

      expect(store.set).toHaveBeenCalledWith("2");
      expect(reload).toHaveBeenCalledOnce();
    } finally {
      stop();
      vi.useRealTimers();
    }
  });
});
