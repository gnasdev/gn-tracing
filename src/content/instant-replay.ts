/**
 * Instant-replay content script (ISOLATED world).
 *
 * Runs the core's rolling DOM buffer. Console/network lookback is owned by the
 * service worker via CDP (`instant-replay-cdp.ts`) on allowlisted domains.
 * Registered only when Instant Replay is enabled — see
 * `instant-replay-registration.ts`.
 *
 * Collect is non-destructive; COMMIT clears DOM after upload ok.
 */

import {
  DEFAULT_INSTANT_REPLAY_WINDOW_MS,
  type InstantReplayRecorder,
  startInstantReplay,
} from "../../packages/replay-core/src/capture/instant-replay";
import {
  COLLECT_INSTANT_REPLAY_ACTION,
  COMMIT_INSTANT_REPLAY_ACTION,
} from "../shared/instant-replay-policy";
import {
  INSTANT_REPLAY_WINDOW_SECONDS_DEFAULT,
  normalizeInstantReplayWindowSeconds,
} from "../shared/instant-replay-window";

const SETTINGS_STORAGE_KEY = "gn_tracing_upload_settings";

interface InstantReplayWindow extends Window {
  __gnTracingInstantReplay?: InstantReplayRecorder;
}

interface InstantReplaySettingsSlice {
  instantReplayWindowSeconds?: unknown;
}

async function resolveWindowMs(): Promise<number> {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
    const settings = stored?.[SETTINGS_STORAGE_KEY] as InstantReplaySettingsSlice | undefined;
    const seconds = normalizeInstantReplayWindowSeconds(
      settings?.instantReplayWindowSeconds,
      INSTANT_REPLAY_WINDOW_SECONDS_DEFAULT,
    );
    return seconds * 1000;
  } catch {
    return DEFAULT_INSTANT_REPLAY_WINDOW_MS;
  }
}

void (async () => {
  const pageWindow = window as InstantReplayWindow;
  if (pageWindow.__gnTracingInstantReplay) {
    return;
  }

  const windowMs = await resolveWindowMs();
  const recorder = startInstantReplay(window, {
    windowMs,
    // Password fields stay out via the serializer defaults.
    includeFormValues: false,
  });
  pageWindow.__gnTracingInstantReplay = recorder;

  window.addEventListener("pagehide", () => {
    recorder.stop();
    recorder.buffer.clear();
  });

  chrome.runtime.onMessage.addListener(
    (message: { action?: string }, _sender, sendResponse: (response: unknown) => void): boolean => {
      const action = message?.action;
      if (action !== COLLECT_INSTANT_REPLAY_ACTION && action !== COMMIT_INSTANT_REPLAY_ACTION) {
        return false;
      }

      if (action === COLLECT_INSTANT_REPLAY_ACTION) {
        // Snapshot only — never clear here. Commit clears after upload ok.
        // Evidence (console/network) is attached by the service worker from CDP.
        sendResponse({
          ok: true,
          artifact: recorder.toArtifact(),
          evidence: null,
          disabledReason: recorder.disabledReason,
        });
        return false;
      }

      // COMMIT: upload succeeded; discard the handed-off lookback.
      recorder.buffer.clear();
      sendResponse({ ok: true });
      return false;
    },
  );
})();
