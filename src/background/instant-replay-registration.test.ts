/**
 * Registration tests.
 *
 * The failure that matters is a script that keeps running after the user turned
 * the feature off, or one registered without the host access it needs. Both are
 * asserted directly.
 */

import { describe, expect, it, vi } from "vitest";
import {
  createRegistrationDeps,
  INSTANT_REPLAY_SCRIPT_ID,
  type RegistrationDeps,
  syncInstantReplayRegistration,
} from "./instant-replay-registration";

function createDeps(overrides: Partial<RegistrationDeps> = {}) {
  let registered: Array<{ id: string }> = [];
  const deps: RegistrationDeps = {
    getRegistered: vi.fn(async () => registered),
    register: vi.fn(async (scripts) => {
      registered = [...registered, ...(scripts as Array<{ id: string }>)];
    }),
    unregister: vi.fn(async ({ ids }) => {
      registered = registered.filter((script) => !ids.includes(script.id));
    }),
    hasHostPermission: vi.fn(async () => true),
    requestHostPermission: vi.fn(async () => true),
    ...overrides,
  };
  return { deps, isRegistered: () => registered.some((s) => s.id === INSTANT_REPLAY_SCRIPT_ID) };
}

describe("syncInstantReplayRegistration", () => {
  it("registers the script when the feature is enabled", async () => {
    const { deps, isRegistered } = createDeps();
    const result = await syncInstantReplayRegistration(true, deps);

    expect(result).toEqual({ ok: true, enabled: true });
    expect(isRegistered()).toBe(true);
  });

  it("is idempotent, so a worker restart does not register it twice", async () => {
    const { deps } = createDeps();
    await syncInstantReplayRegistration(true, deps);
    await syncInstantReplayRegistration(true, deps);

    expect(deps.register).toHaveBeenCalledTimes(1);
  });

  it("unregisters rather than leaving the script idling when disabled", async () => {
    const { deps, isRegistered } = createDeps();
    await syncInstantReplayRegistration(true, deps);
    const result = await syncInstantReplayRegistration(false, deps);

    expect(result).toEqual({ ok: true, enabled: false });
    expect(deps.unregister).toHaveBeenCalledWith({ ids: [INSTANT_REPLAY_SCRIPT_ID] });
    expect(isRegistered()).toBe(false);
  });

  it("does not register when host permission is refused", async () => {
    const { deps, isRegistered } = createDeps({
      hasHostPermission: vi.fn(async () => false),
      requestHostPermission: vi.fn(async () => false),
    });

    const result = await syncInstantReplayRegistration(true, deps);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/needs permission/i);
    expect(deps.register).not.toHaveBeenCalled();
    expect(isRegistered()).toBe(false);
  });

  it("tears the script down if permission is revoked after it was registered", async () => {
    let granted = true;
    const { deps, isRegistered } = createDeps({
      hasHostPermission: vi.fn(async () => granted),
      requestHostPermission: vi.fn(async () => granted),
    });

    await syncInstantReplayRegistration(true, deps);
    expect(isRegistered()).toBe(true);

    granted = false;
    const result = await syncInstantReplayRegistration(true, deps);

    expect(result.ok).toBe(false);
    expect(isRegistered()).toBe(false);
  });

  it("asks for permission only once when it is already held", async () => {
    const { deps } = createDeps();
    await syncInstantReplayRegistration(true, deps);
    expect(deps.requestHostPermission).not.toHaveBeenCalled();
  });
});

describe("createRegistrationDeps", () => {
  it("builds a dependency set bound to the chrome APIs", () => {
    const deps = createRegistrationDeps();
    expect(typeof deps.register).toBe("function");
    expect(typeof deps.hasHostPermission).toBe("function");
  });
});
