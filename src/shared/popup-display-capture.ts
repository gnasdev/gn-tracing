/**
 * Firefox display-stream handoff helpers (popup share → media host adopt).
 *
 * Preferred Firefox Start path: call getDisplayMedia from the toolbar-popup
 * click so the OS share picker opens immediately — no intermediate "Choose what
 * to share" panel. After the stream is live, park the media-host window and
 * transfer tracks for MediaRecorder. If popup capture is rejected, the runtime
 * falls back to media-host auto-arm (then tab-frame).
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
    audio: false,
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
 * Media host is a `windows.create({ type: "popup" })` window (or window.open),
 * so search all view types — not only `tab`.
 */
export function findMediaHostView(
  getViews: (fetchProperties?: { type?: string }) => Window[] = (props) =>
    chrome.extension.getViews(props as chrome.extension.FetchProperties | undefined),
  mediaPagePath = "offscreen/offscreen.html",
): Window | null {
  try {
    const buckets: Window[] = [];
    for (const props of [undefined, { type: "tab" }, { type: "popup" }] as const) {
      try {
        const found = props ? getViews(props) : getViews();
        if (Array.isArray(found)) {
          buckets.push(...found);
        }
      } catch {
        // Some engines reject certain type filters.
      }
    }
    const seen = new Set<Window>();
    for (const view of buckets) {
      if (!view || seen.has(view)) {
        continue;
      }
      seen.add(view);
      try {
        if (isMediaHostViewUrl(view.location?.href || "", mediaPagePath)) {
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

/** Named window so repeated Start clicks reuse one media host. */
export const MEDIA_HOST_WINDOW_NAME = "gn-tracing-media-host";

/**
 * Open (or reuse) the media-host page for track handoff / MediaRecorder.
 * Prefer calling this *after* the OS share picker is already up (or the stream
 * is live) so the user is not shown offscreen.html instead of the picker.
 * Window is tiny; packaging minimizes it once capture is armed.
 */
export function parkMediaHostWindowFromPopup(
  openWindow: (url: string, target: string, features: string) => Window | null = (
    url,
    target,
    features,
  ) => window.open(url, target, features),
  getUrl: (path: string) => string = (path) => chrome.runtime.getURL(path),
  mediaPagePath = "offscreen/offscreen.html",
): Window | null {
  try {
    const url = getUrl(mediaPagePath);
    // Small unfocused-looking popup: MediaRecorder only; not a chooser UI.
    return openWindow(url, MEDIA_HOST_WINDOW_NAME, "popup,width=1,height=1,left=0,top=0");
  } catch {
    return null;
  }
}

/** Poll until the media host document is reachable via getViews. */
export async function waitForMediaHostView(
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    findView?: () => Window | null;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<Window | null> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 50;
  const findView = options.findView ?? (() => findMediaHostView());
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const started = Date.now();
  for (;;) {
    const view = findView();
    if (view) {
      return view;
    }
    if (Date.now() - started >= timeoutMs) {
      return null;
    }
    await sleep(intervalMs);
  }
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
    microphoneDeviceId?: string;
    speakerDeviceId?: string;
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
    return {
      sessionId,
      ok: false,
      error: "Screen share produced no media tracks.",
    };
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
      const data = event.data as {
        type?: string;
      } & Partial<AdoptDisplayStreamResult>;
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
          microphoneDeviceId: options.microphoneDeviceId ?? "",
          speakerDeviceId: options.speakerDeviceId ?? "",
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
