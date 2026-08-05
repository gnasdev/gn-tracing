/**
 * Firefox display-stream handoff helpers (media host adopt path).
 *
 * Historical attempt: open getDisplayMedia from the browser-action popup and
 * transfer tracks into the parked media-host tab. Firefox rejects that popup
 * capture (NotAllowedError), so full-record now arms getDisplayMedia only on
 * the media host tab. These helpers remain for adopt-message wiring tests and
 * any future durable surface that is not the browser-action popup.
 */

import type { CapturedSurface } from "../media-pipeline/capture-surface";

/** window.postMessage type for stream adoption (popup → media host view). */
export const ADOPT_DISPLAY_STREAM_MESSAGE = "GN_TRACING_ADOPT_DISPLAY_STREAM" as const;

/** window.postMessage type for adopt result (media host → popup). */
export const ADOPT_DISPLAY_STREAM_RESULT = "GN_TRACING_ADOPT_DISPLAY_STREAM_RESULT" as const;

export type AdoptDisplayStreamResult = {
  sessionId: string;
  ok: boolean;
  firstFrameAt?: number | null;
  cancelled?: boolean;
  error?: string;
  surface?: CapturedSurface;
};

/**
 * Constraints aligned with acquireCaptureStream("display-media") so popup and
 * media-tab capture request the same surface.
 */
export function buildDisplayMediaConstraints(): DisplayMediaStreamOptions {
  return {
    video: {
      preferCurrentTab: true,
      displaySurface: "browser",
      width: { ideal: 1920, max: 1920 },
      height: { ideal: 1080, max: 1080 },
      frameRate: { ideal: 30, max: 30 },
    },
    audio: true,
  } as DisplayMediaStreamOptions;
}

/** Start getDisplayMedia in the same turn as a user gesture (no await before this). */
export function beginDisplayMediaFromGesture(
  getDisplayMedia: (constraints?: DisplayMediaStreamOptions) => Promise<MediaStream> = (c) =>
    navigator.mediaDevices.getDisplayMedia(c),
): Promise<MediaStream> {
  return getDisplayMedia(buildDisplayMediaConstraints());
}

export function isMediaHostViewUrl(
  href: string,
  mediaPagePath = "offscreen/offscreen.html",
): boolean {
  try {
    const url = new URL(href);
    return url.pathname.endsWith(mediaPagePath) || url.pathname.includes(`/${mediaPagePath}`);
  } catch {
    return href.includes(mediaPagePath);
  }
}

/**
 * Locate the parked media-host extension page via chrome.extension.getViews.
 * Returns null when the tab is not open or getViews is unavailable.
 */
export function findMediaHostView(
  getViews: (fetchProperties?: { type?: string }) => Window[] = (props) =>
    chrome.extension.getViews(props as chrome.extension.FetchProperties | undefined),
  mediaPagePath = "offscreen/offscreen.html",
): Window | null {
  try {
    const views = getViews({ type: "tab" });
    for (const view of views) {
      try {
        if (view && isMediaHostViewUrl(view.location?.href || "", mediaPagePath)) {
          return view;
        }
      } catch {
        // Cross-view access can throw if a view is closing.
      }
    }
  } catch {
    return null;
  }
  return null;
}

export type HandoffMessageBus = {
  addEventListener: (type: "message", listener: (event: MessageEvent) => void) => void;
  removeEventListener: (type: "message", listener: (event: MessageEvent) => void) => void;
  setTimeout: (handler: () => void, timeout: number) => number;
  clearTimeout: (id: number) => void;
};

function defaultMessageBus(): HandoffMessageBus {
  return {
    addEventListener: (type, listener) =>
      globalThis.addEventListener(type, listener as EventListener),
    removeEventListener: (type, listener) =>
      globalThis.removeEventListener(type, listener as EventListener),
    setTimeout: (handler, timeout) => globalThis.setTimeout(handler, timeout) as unknown as number,
    clearTimeout: (id) => globalThis.clearTimeout(id),
  };
}

/**
 * Transfer live tracks into the media host window and wait for adopt result.
 * Tracks are moved (not cloned): the popup loses them after a successful post.
 */
export async function handoffDisplayStreamToMediaHost(
  stream: MediaStream,
  sessionId: string,
  options: {
    findView?: () => Window | null;
    timeoutMs?: number;
    messageBus?: HandoffMessageBus;
  } = {},
): Promise<AdoptDisplayStreamResult> {
  const findView = options.findView ?? (() => findMediaHostView());
  const timeoutMs = options.timeoutMs ?? 30_000;
  const bus = options.messageBus ?? defaultMessageBus();
  const view = findView();
  if (!view) {
    return {
      sessionId,
      ok: false,
      error: "Capture host page is not open. Try starting the recording again.",
    };
  }

  const tracks = stream.getTracks();
  if (tracks.length === 0) {
    return { sessionId, ok: false, error: "Screen share produced no media tracks." };
  }

  return new Promise<AdoptDisplayStreamResult>((resolve) => {
    let settled = false;
    const finish = (result: AdoptDisplayStreamResult) => {
      if (settled) {
        return;
      }
      settled = true;
      bus.clearTimeout(timeoutId);
      bus.removeEventListener("message", onMessage);
      resolve(result);
    };

    const onMessage = (event: MessageEvent) => {
      if (event.source !== view) {
        return;
      }
      const data = event.data as { type?: string } & Partial<AdoptDisplayStreamResult>;
      if (data?.type !== ADOPT_DISPLAY_STREAM_RESULT || data.sessionId !== sessionId) {
        return;
      }
      finish({
        sessionId,
        ok: Boolean(data.ok),
        firstFrameAt: data.firstFrameAt ?? null,
        cancelled: data.cancelled,
        error: data.error,
        surface: data.surface,
      });
    };

    bus.addEventListener("message", onMessage);
    const timeoutId = bus.setTimeout(() => {
      finish({
        sessionId,
        ok: false,
        error: "Timed out handing the screen share to the capture host.",
      });
    }, timeoutMs);

    try {
      const origin = view.location.origin;
      view.postMessage(
        {
          type: ADOPT_DISPLAY_STREAM_MESSAGE,
          sessionId,
          tracks,
        },
        origin,
        tracks,
      );
    } catch (error) {
      finish({
        sessionId,
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Could not transfer the screen share to the capture host.",
      });
    }
  });
}

export function createRecordingSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
