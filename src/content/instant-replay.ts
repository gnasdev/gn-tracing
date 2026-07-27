/**
 * Instant-replay content script.
 *
 * Runs the core's rolling DOM buffer inside the page so a screenshot report can
 * include the seconds *before* the bug, without the reporter having to
 * reproduce it.
 *
 * This is the one script in the extension that runs without the user having
 * started anything, so it is registered only when they turn the feature on in
 * Settings and grant host access — see
 * `src/background/instant-replay-registration.ts`. Everything it collects stays
 * in this page's memory until the service worker asks for it, and the buffer is
 * dropped on a fixed cycle so a tab left open overnight is not quietly holding
 * a recording of it.
 */

import {
  type InstantReplayRecorder,
  startInstantReplay,
} from "../../packages/replay-core/src/capture/instant-replay";

/** How often the buffer is discarded outright, regardless of the time window. */
const PURGE_INTERVAL_MS = 120_000;

interface InstantReplayWindow extends Window {
  __gnTracingInstantReplay?: InstantReplayRecorder;
}

(() => {
  const pageWindow = window as InstantReplayWindow;
  if (pageWindow.__gnTracingInstantReplay) {
    return;
  }

  const recorder = startInstantReplay(window, {
    // Mask selectors are applied by the service worker's settings when a report
    // is packaged; the in-page default keeps password fields out of the buffer
    // through the serializer's own rules.
    includeFormValues: false,
  });
  pageWindow.__gnTracingInstantReplay = recorder;

  const purgeTimer = window.setInterval(() => {
    recorder.buffer.clear();
  }, PURGE_INTERVAL_MS);

  window.addEventListener("pagehide", () => {
    recorder.stop();
    recorder.buffer.clear();
    window.clearInterval(purgeTimer);
  });

  chrome.runtime.onMessage.addListener(
    (message: { action?: string }, _sender, sendResponse: (response: unknown) => void): boolean => {
      if (message?.action !== "COLLECT_INSTANT_REPLAY") {
        return false;
      }

      sendResponse({
        ok: true,
        artifact: recorder.toArtifact(),
        disabledReason: recorder.disabledReason,
      });
      // Handing the frames over ends their purpose here; keeping a copy would
      // mean the next report silently re-sends the same history.
      recorder.buffer.clear();
      return false;
    },
  );
})();
