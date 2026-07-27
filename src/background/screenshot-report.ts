/**
 * The screenshot-report flow: capture → annotate → package → upload.
 *
 * A screenshot report is the cheap path. Most bug reports are "this looks
 * wrong, here", and forcing someone through a video recording to say that costs
 * them a minute and costs the reader a video to scrub. Jam separates the two
 * for the same reason.
 *
 * The pending capture lives in `chrome.storage.session` rather than in a module
 * variable because an MV3 service worker is evicted between the click that
 * captures and the click that saves — the editor page outlives the worker that
 * opened it.
 */

import type { Screenshot } from "../../packages/replay-core/src/schema/annotation";

const PENDING_KEY = "gn_tracing_pending_screenshot";

/** Matches the recording path's own screenshot ceiling. */
const MAX_SCREENSHOT_DATA_URL_CHARS = 1536 * 1024;

export interface PendingScreenshot {
  id: string;
  imageDataUrl: string;
  capturedAt: number;
  url?: string;
  title?: string;
  viewport: { width: number; height: number; devicePixelRatio?: number };
  /** Kept so the report can ask this tab for its instant-replay buffer. */
  tabId: number;
}

export interface CaptureDeps {
  captureVisibleTab: (windowId: number) => Promise<string>;
  getTab: (tabId: number) => Promise<{ windowId?: number; url?: string; title?: string }>;
  /** Reads viewport size from the page; falls back to the image's own size. */
  getViewport: (
    tabId: number,
  ) => Promise<{ width: number; height: number; devicePixelRatio?: number } | null>;
  setPending: (pending: PendingScreenshot) => Promise<void>;
  openEditor: () => Promise<void>;
}

export type CaptureResult = { ok: true; id: string } | { ok: false; error: string };

let captureCounter = 0;

function nextScreenshotId(now: number): string {
  captureCounter += 1;
  return `shot-${now.toString(36)}-${captureCounter.toString(36)}`;
}

/**
 * Captures the visible tab and parks it for the editor.
 *
 * Pure-ish by injection so the size ceiling and the failure paths are testable
 * without a browser; the caller supplies the `chrome.*` calls.
 */
export async function captureScreenshotForAnnotation(
  tabId: number,
  deps: CaptureDeps,
): Promise<CaptureResult> {
  let tab: { windowId?: number; url?: string; title?: string };
  try {
    tab = await deps.getTab(tabId);
  } catch (error) {
    return { ok: false, error: `Could not read the active tab: ${describe(error)}` };
  }

  if (tab.windowId == null) {
    return { ok: false, error: "The active tab has no window to capture." };
  }

  let imageDataUrl: string;
  try {
    imageDataUrl = await deps.captureVisibleTab(tab.windowId);
  } catch (error) {
    return { ok: false, error: `Screenshot capture failed: ${describe(error)}` };
  }

  if (!imageDataUrl.startsWith("data:image/")) {
    return { ok: false, error: "Screenshot capture returned no image." };
  }
  if (imageDataUrl.length > MAX_SCREENSHOT_DATA_URL_CHARS) {
    return {
      ok: false,
      error: "The screenshot is too large to annotate. Try a smaller window.",
    };
  }

  const viewport = (await deps.getViewport(tabId).catch(() => null)) ?? {
    width: 1280,
    height: 800,
  };

  const capturedAt = Date.now();
  const pending: PendingScreenshot = {
    id: nextScreenshotId(capturedAt),
    imageDataUrl,
    capturedAt,
    url: tab.url,
    title: tab.title,
    viewport,
    tabId,
  };

  await deps.setPending(pending);
  await deps.openEditor();
  return { ok: true, id: pending.id };
}

/** Reads the parked capture, or null when there is none. */
export async function readPendingScreenshot(): Promise<PendingScreenshot | null> {
  const stored = await chrome.storage.session.get(PENDING_KEY);
  const value = stored?.[PENDING_KEY];
  return value && typeof value === "object" ? (value as PendingScreenshot) : null;
}

export async function writePendingScreenshot(pending: PendingScreenshot): Promise<void> {
  await chrome.storage.session.set({ [PENDING_KEY]: pending });
}

/**
 * Clears the parked capture.
 *
 * Always called after a save or a discard: the image is a picture of the user's
 * screen and there is no reason for it to outlive the report it belongs to.
 */
export async function clearPendingScreenshot(): Promise<void> {
  await chrome.storage.session.remove(PENDING_KEY);
}

/**
 * Merges the annotations the editor produced onto the parked capture.
 *
 * The editor sends coordinates and shapes but not the image, so the bytes never
 * make a second trip through the message channel.
 */
export function mergeAnnotatedScreenshot(
  pending: PendingScreenshot,
  annotated: Screenshot,
): { screenshot: Screenshot; imageDataUrl: string } {
  return {
    screenshot: {
      ...annotated,
      id: pending.id,
      capturedAt: pending.capturedAt,
      url: pending.url,
      title: pending.title,
      viewport: pending.viewport,
    },
    imageDataUrl: pending.imageDataUrl,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
