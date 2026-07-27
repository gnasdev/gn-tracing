/**
 * Registering and unregistering the instant-replay content script.
 *
 * Instant replay is the only part of this extension that observes a page the
 * user has not asked to record. That makes it a permission decision, not a
 * preference: turning it on requests host access explicitly, and turning it off
 * unregisters the script rather than merely telling it to idle.
 *
 * Written against injected `chrome.*` surfaces so the enable/disable logic —
 * where a mistake means a script keeps running after the user switched it off —
 * is testable.
 */

export const INSTANT_REPLAY_SCRIPT_ID = "gn-tracing-instant-replay";

export interface RegistrationDeps {
  getRegistered: () => Promise<Array<{ id: string }>>;
  register: (scripts: Array<Record<string, unknown>>) => Promise<void>;
  unregister: (filter: { ids: string[] }) => Promise<void>;
  hasHostPermission: () => Promise<boolean>;
  requestHostPermission: () => Promise<boolean>;
}

export type RegistrationResult = { ok: true; enabled: boolean } | { ok: false; error: string };

async function isRegistered(deps: RegistrationDeps): Promise<boolean> {
  const scripts = await deps.getRegistered().catch(() => []);
  return scripts.some((script) => script.id === INSTANT_REPLAY_SCRIPT_ID);
}

/**
 * Brings registration in line with the setting.
 *
 * Idempotent: called on every settings save and on worker startup, because an
 * MV3 worker restart must not silently leave the script registered when the
 * setting says off (or vice versa).
 */
export async function syncInstantReplayRegistration(
  enabled: boolean,
  deps: RegistrationDeps,
): Promise<RegistrationResult> {
  const registered = await isRegistered(deps);

  if (!enabled) {
    if (registered) {
      await deps.unregister({ ids: [INSTANT_REPLAY_SCRIPT_ID] });
    }
    return { ok: true, enabled: false };
  }

  // Ask before registering, never after: a script registered without host
  // access would fail on every page and leave the UI claiming it is on.
  const granted = (await deps.hasHostPermission()) || (await deps.requestHostPermission());
  if (!granted) {
    if (registered) {
      await deps.unregister({ ids: [INSTANT_REPLAY_SCRIPT_ID] });
    }
    return {
      ok: false,
      error:
        "Instant replay needs permission to run on the pages you browse. It stays off until that is granted.",
    };
  }

  if (registered) {
    return { ok: true, enabled: true };
  }

  await deps.register([
    {
      id: INSTANT_REPLAY_SCRIPT_ID,
      js: ["content/instant-replay.js"],
      matches: ["http://*/*", "https://*/*"],
      runAt: "document_idle",
      allFrames: false,
      persistAcrossSessions: true,
    },
  ]);

  return { ok: true, enabled: true };
}

/** The live `chrome.*` implementation. */
export function createRegistrationDeps(): RegistrationDeps {
  const origins = ["http://*/*", "https://*/*"];
  return {
    getRegistered: () => chrome.scripting.getRegisteredContentScripts(),
    register: (scripts) =>
      chrome.scripting.registerContentScripts(
        scripts as unknown as chrome.scripting.RegisteredContentScript[],
      ),
    unregister: (filter) => chrome.scripting.unregisterContentScripts(filter),
    hasHostPermission: () => chrome.permissions.contains({ origins }),
    requestHostPermission: () => chrome.permissions.request({ origins }),
  };
}
