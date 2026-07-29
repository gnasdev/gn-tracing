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
  INSTANT_REPLAY_EVIDENCE_SCRIPT_ID,
  INSTANT_REPLAY_SCRIPT_ID,
  type RegistrationDeps,
  syncInstantReplayRegistration,
  unregisterLegacyInstantReplayScript,
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
  return {
    deps,
    isRegistered: () => registered.some((s) => s.id === INSTANT_REPLAY_SCRIPT_ID),
    getRegistered: () => registered,
  };
}

describe("syncInstantReplayRegistration", () => {
  it("registers only the DOM orchestrator when the feature is enabled", async () => {
    const injectIntoOpenTabs = vi.fn(async () => {});
    const { deps, isRegistered } = createDeps({ injectIntoOpenTabs });
    const result = await syncInstantReplayRegistration(true, deps);

    expect(result).toEqual({ ok: true, enabled: true });
    expect(isRegistered()).toBe(true);
    expect(injectIntoOpenTabs).toHaveBeenCalledOnce();
    const registeredScripts = (deps.register as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as Array<{ id: string; world?: string }>;
    expect(registeredScripts.map((s) => s.id)).toEqual([INSTANT_REPLAY_SCRIPT_ID]);
    expect(registeredScripts[0]?.world).toBe("ISOLATED");
  });

  it("unregisters legacy MAIN evidence scripts when enabling", async () => {
    const { deps, getRegistered } = createDeps();
    // Simulate leftover MAIN evidence id from an older build.
    (deps.getRegistered as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: INSTANT_REPLAY_EVIDENCE_SCRIPT_ID },
    ]);
    (deps.getRegistered as ReturnType<typeof vi.fn>).mockImplementation(async () =>
      getRegistered(),
    );
    // Seed state: only evidence registered.
    await deps.register([{ id: INSTANT_REPLAY_EVIDENCE_SCRIPT_ID }] as Array<
      Record<string, unknown>
    >);

    await syncInstantReplayRegistration(true, deps);

    expect(getRegistered().some((s) => s.id === INSTANT_REPLAY_EVIDENCE_SCRIPT_ID)).toBe(false);
    expect(getRegistered().some((s) => s.id === INSTANT_REPLAY_SCRIPT_ID)).toBe(true);
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
    expect(deps.unregister).toHaveBeenCalled();
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

describe("unregisterLegacyInstantReplayScript", () => {
  it("unregisters a leftover always-on script", async () => {
    const { deps, isRegistered } = createDeps();
    await syncInstantReplayRegistration(true, deps);

    const result = await unregisterLegacyInstantReplayScript(deps);

    expect(result).toEqual({ ok: true, wasRegistered: true });
    expect(isRegistered()).toBe(false);
  });

  it("is a no-op when nothing is registered", async () => {
    const { deps, isRegistered } = createDeps();
    const result = await unregisterLegacyInstantReplayScript(deps);
    expect(result).toEqual({ ok: true, wasRegistered: false });
    expect(deps.unregister).not.toHaveBeenCalled();
    expect(isRegistered()).toBe(false);
  });
});

describe("createRegistrationDeps", () => {
  it("builds a dependency set bound to the chrome APIs", () => {
    const deps = createRegistrationDeps();
    expect(typeof deps.register).toBe("function");
    expect(typeof deps.hasHostPermission).toBe("function");
    expect(typeof deps.unregister).toBe("function");
  });
});
