/**
 * Registering and unregistering the instant-replay content script.
 *
 * Instant replay is the only part of this extension that observes a page the
 * user has not asked to record. That makes it a permission decision, not a
 * preference: turning it on requests host access explicitly, and turning it off
 * unregisters the script rather than merely telling it to idle.
 *
 * Console/network lookback uses CDP (see `instant-replay-cdp.ts`), not a MAIN
 * world content script.
 *
 * Written against injected `chrome.*` surfaces so the enable/disable logic —
 * where a mistake means a script keeps running after the user switched it off —
 * is testable.
 */

import {
  hasRecordingHostPermission,
  RECORDING_HOST_ORIGINS,
  requestRecordingHostPermission,
} from "../shared/recording-host-permission";

export const INSTANT_REPLAY_SCRIPT_ID = "gn-tracing-instant-replay";
/** @deprecated MAIN-world evidence; unregistered on sync for cleanup. */
export const INSTANT_REPLAY_EVIDENCE_SCRIPT_ID = "gn-tracing-instant-replay-evidence";

const LEGACY_IR_SCRIPT_IDS = [INSTANT_REPLAY_SCRIPT_ID, INSTANT_REPLAY_EVIDENCE_SCRIPT_ID] as const;

export interface RegistrationDeps {
  getRegistered: () => Promise<Array<{ id: string }>>;
  register: (scripts: Array<Record<string, unknown>>) => Promise<void>;
  unregister: (filter: { ids: string[] }) => Promise<void>;
  hasHostPermission: () => Promise<boolean>;
  requestHostPermission: () => Promise<boolean>;
  /**
   * Optional: inject the content script into already-open matching tabs after
   * register. Without this, only navigations after enable start buffering.
   */
  injectIntoOpenTabs?: () => Promise<void>;
}

export type RegistrationResult = { ok: true; enabled: boolean } | { ok: false; error: string };

async function registeredIds(deps: RegistrationDeps): Promise<Set<string>> {
  const scripts = await deps.getRegistered().catch(() => []);
  return new Set(scripts.map((script) => script.id));
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
  if (!enabled) {
    const ids = await registeredIds(deps);
    const toRemove = LEGACY_IR_SCRIPT_IDS.filter((id) => ids.has(id));
    if (toRemove.length > 0) {
      await deps.unregister({ ids: [...toRemove] });
    }
    return { ok: true, enabled: false };
  }

  // Ask before registering, never after: a script registered without host
  // access would fail on every page and leave the UI claiming it is on.
  const granted = (await deps.hasHostPermission()) || (await deps.requestHostPermission());
  if (!granted) {
    const ids = await registeredIds(deps);
    const toRemove = LEGACY_IR_SCRIPT_IDS.filter((id) => ids.has(id));
    if (toRemove.length > 0) {
      await deps.unregister({ ids: [...toRemove] });
    }
    return {
      ok: false,
      error:
        "Instant replay needs permission to run on the pages you browse. It stays off until that is granted.",
    };
  }

  const ids = await registeredIds(deps);
  // Drop legacy MAIN evidence script if present from older builds.
  if (ids.has(INSTANT_REPLAY_EVIDENCE_SCRIPT_ID)) {
    await deps.unregister({ ids: [INSTANT_REPLAY_EVIDENCE_SCRIPT_ID] });
    ids.delete(INSTANT_REPLAY_EVIDENCE_SCRIPT_ID);
  }

  if (!ids.has(INSTANT_REPLAY_SCRIPT_ID)) {
    await deps.register([
      {
        id: INSTANT_REPLAY_SCRIPT_ID,
        js: ["content/instant-replay.js"],
        matches: [...RECORDING_HOST_ORIGINS],
        runAt: "document_idle",
        allFrames: false,
        persistAcrossSessions: true,
        world: "ISOLATED",
      },
    ]);
  }

  if (deps.injectIntoOpenTabs) {
    await deps.injectIntoOpenTabs().catch(() => {
      // Individual tab inject failures must not flip the setting off.
    });
  }

  return { ok: true, enabled: true };
}

/**
 * Unregister the always-on script if present. Idempotent; used when disabling
 * or as a safe cleanup helper.
 */
export async function unregisterLegacyInstantReplayScript(
  deps: Pick<RegistrationDeps, "getRegistered" | "unregister">,
): Promise<{ ok: true; wasRegistered: boolean }> {
  const scripts = await deps.getRegistered().catch(() => []);
  const present = scripts
    .map((script) => script.id)
    .filter((id) => (LEGACY_IR_SCRIPT_IDS as readonly string[]).includes(id));
  if (present.length > 0) {
    await deps.unregister({ ids: present });
  }
  return { ok: true, wasRegistered: present.length > 0 };
}

/** The live `chrome.*` implementation. */
export function createRegistrationDeps(): RegistrationDeps {
  return {
    getRegistered: () => chrome.scripting.getRegisteredContentScripts(),
    register: (scripts) =>
      chrome.scripting.registerContentScripts(
        scripts as unknown as chrome.scripting.RegisteredContentScript[],
      ),
    unregister: (filter) => chrome.scripting.unregisterContentScripts(filter),
    // Same origins as full-record Firefox host permission (shared constant).
    hasHostPermission: () => hasRecordingHostPermission(),
    requestHostPermission: () => requestRecordingHostPermission(),
    injectIntoOpenTabs: async () => {
      const tabs = await chrome.tabs.query({
        url: [...RECORDING_HOST_ORIGINS],
      });
      await Promise.all(
        tabs.map(async (tab) => {
          if (typeof tab.id !== "number") {
            return;
          }
          try {
            await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ["content/instant-replay.js"],
              world: "ISOLATED",
            });
          } catch {
            // Restricted pages / race with navigation — leave for next load.
          }
        }),
      );
    },
  };
}
