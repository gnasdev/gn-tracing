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
 *
 * Instant Replay reuses the same annotate path: it freezes lookback at capture
 * time, parks a kind-discriminated pending payload, and only packages on save.
 */

import type { InstantReplayEvidenceBundle } from "../../packages/replay-core/src/capture/instant-replay-evidence";
import type {
  InstantReplayArtifact,
  Screenshot,
} from "../../packages/replay-core/src/schema/annotation";
import { hasInstantReplayFrames } from "../shared/instant-replay-policy";

const PENDING_KEY = "gn_tracing_pending_screenshot";

/** Matches the recording path's own screenshot ceiling. */
export const MAX_SCREENSHOT_DATA_URL_CHARS = 1536 * 1024;

/**
 * Frozen Instant Replay lookback parked with the pending capture so annotation
 * time does not change which buffer frames ship in the package.
 */
export interface FrozenInstantReplay {
  artifact: InstantReplayArtifact;
  evidence: InstantReplayEvidenceBundle | null;
}

/** Fields shared by every parked annotate session. */
export interface PendingCaptureBase {
  id: string;
  imageDataUrl: string;
  capturedAt: number;
  url?: string;
  title?: string;
  viewport: { width: number; height: number; devicePixelRatio?: number };
  /** Tab that produced the still (and optionally the IR buffer). */
  tabId: number;
}

/**
 * Kind-discriminated pending capture.
 * - `screenshot`: still only; save may optionally attach a *live* IR collect.
 * - `instant-replay`: still + frozen lookback required at park time.
 */
export type PendingCapture =
  | (PendingCaptureBase & { kind: "screenshot" })
  | (PendingCaptureBase & {
      kind: "instant-replay";
      frozenInstantReplay: FrozenInstantReplay;
    });

/** @deprecated Prefer PendingCapture; kept as alias for call sites mid-migration. */
export type PendingScreenshot = PendingCapture;

export interface CaptureDeps {
  captureVisibleTab: (windowId: number) => Promise<string>;
  getTab: (tabId: number) => Promise<{ windowId?: number; url?: string; title?: string }>;
  /** Reads viewport size from the page; falls back to the image's own size. */
  getViewport: (
    tabId: number,
  ) => Promise<{ width: number; height: number; devicePixelRatio?: number } | null>;
  /**
   * Park the capture. Must throw or reject on storage/quota failure so the
   * editor is not opened without a readable pending payload.
   */
  setPending: (pending: PendingCapture) => Promise<void>;
  openEditor: () => Promise<void>;
  /**
   * Optional transform after the base still is built (IR freezes lookback here).
   * Must return a valid PendingCapture; invalid IR freezes are rejected.
   */
  finalizePending?: (base: PendingCaptureBase) => PendingCapture | Promise<PendingCapture>;
}

export type CaptureResult = { ok: true; id: string } | { ok: false; error: string };

let captureCounter = 0;

function nextScreenshotId(now: number): string {
  captureCounter += 1;
  return `shot-${now.toString(36)}-${captureCounter.toString(36)}`;
}

export function nextInstantReplayCaptureId(now: number): string {
  captureCounter += 1;
  return `ir-${now.toString(36)}-${captureCounter.toString(36)}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Validate a parked payload. IR without frames is not representable as a valid
 * pending capture for the annotate path.
 */
export function parsePendingCapture(value: unknown): PendingCapture | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || typeof raw.imageDataUrl !== "string") {
    return null;
  }
  if (typeof raw.capturedAt !== "number" || typeof raw.tabId !== "number") {
    return null;
  }
  if (!raw.imageDataUrl.startsWith("data:image/")) {
    return null;
  }
  const viewport = raw.viewport;
  if (!viewport || typeof viewport !== "object") {
    return null;
  }
  const vp = viewport as { width?: unknown; height?: unknown; devicePixelRatio?: unknown };
  if (typeof vp.width !== "number" || typeof vp.height !== "number") {
    return null;
  }

  const base: PendingCaptureBase = {
    id: raw.id,
    imageDataUrl: raw.imageDataUrl,
    capturedAt: raw.capturedAt,
    url: typeof raw.url === "string" ? raw.url : undefined,
    title: typeof raw.title === "string" ? raw.title : undefined,
    viewport: {
      width: vp.width,
      height: vp.height,
      devicePixelRatio: typeof vp.devicePixelRatio === "number" ? vp.devicePixelRatio : undefined,
    },
    tabId: raw.tabId,
  };

  // Discriminator: prefer explicit kind; reject IR-shaped optional-flag legacy.
  if (raw.kind === "instant-replay") {
    const frozen = raw.frozenInstantReplay;
    if (!frozen || typeof frozen !== "object") {
      return null;
    }
    const artifact = (frozen as FrozenInstantReplay).artifact;
    if (!hasInstantReplayFrames(artifact ?? null)) {
      return null;
    }
    return {
      ...base,
      kind: "instant-replay",
      frozenInstantReplay: {
        artifact: artifact as InstantReplayArtifact,
        evidence: (frozen as FrozenInstantReplay).evidence ?? null,
      },
    };
  }

  // Default and explicit screenshot kind.
  if (raw.kind === "screenshot" || raw.kind == null) {
    return { ...base, kind: "screenshot" };
  }

  return null;
}

/**
 * Build a valid IR pending capture or throw a user-visible Error.
 */
export function buildInstantReplayPending(
  base: PendingCaptureBase,
  frozen: FrozenInstantReplay,
  options: { id?: string; url?: string } = {},
): PendingCapture {
  if (!hasInstantReplayFrames(frozen.artifact)) {
    throw new Error(
      "Instant Replay lookback is empty. Browse a bit after enabling Instant Replay, then try again.",
    );
  }
  return {
    ...base,
    id: options.id ?? nextInstantReplayCaptureId(base.capturedAt),
    url: options.url ?? base.url,
    kind: "instant-replay",
    frozenInstantReplay: {
      artifact: frozen.artifact,
      evidence: frozen.evidence ?? null,
    },
  };
}

export function isInstantReplayPending(
  pending: PendingCapture,
): pending is PendingCapture & { kind: "instant-replay" } {
  return pending.kind === "instant-replay";
}

/**
 * Resolve which IR bundle (if any) to attach on annotated save.
 * IR reports always use the freeze; screenshots may live-collect when enabled.
 */
export function resolveInstantReplayForSave(
  pending: PendingCapture,
  options: {
    instantReplayEnabled: boolean;
    liveCollect: () => Promise<
      | { ok: true; artifact: InstantReplayArtifact; evidence: InstantReplayEvidenceBundle | null }
      | { ok: false; error: string }
    >;
  },
): Promise<
  | { mode: "none" }
  | {
      mode: "attach";
      artifact: InstantReplayArtifact;
      evidence: InstantReplayEvidenceBundle | null;
      required: boolean;
    }
  | { mode: "error"; error: string }
> {
  if (pending.kind === "instant-replay") {
    if (!hasInstantReplayFrames(pending.frozenInstantReplay.artifact)) {
      return Promise.resolve({
        mode: "error",
        error: "Instant Replay lookback is missing. Capture again after browsing briefly.",
      });
    }
    return Promise.resolve({
      mode: "attach",
      artifact: pending.frozenInstantReplay.artifact,
      evidence: pending.frozenInstantReplay.evidence,
      required: true,
    });
  }

  if (!options.instantReplayEnabled) {
    return Promise.resolve({ mode: "none" });
  }

  return options.liveCollect().then((collected) => {
    if (!collected.ok) {
      // Optional attach for plain screenshots: skip rather than fail the upload.
      return { mode: "none" as const };
    }
    if (!hasInstantReplayFrames(collected.artifact)) {
      return { mode: "none" as const };
    }
    return {
      mode: "attach" as const,
      artifact: collected.artifact,
      evidence: collected.evidence,
      required: false,
    };
  });
}

/** Default caption when the editor left IR caption blank. */
export function defaultCaptionForPending(
  pending: PendingCapture,
  caption: string | undefined,
): string | undefined {
  const trimmed = caption?.trim();
  if (trimmed) {
    return trimmed;
  }
  if (pending.kind === "instant-replay") {
    return "Instant Replay capture";
  }
  return undefined;
}

/**
 * Captures the visible tab and parks it for the editor.
 *
 * Parks first; opens the editor only after setPending succeeds so quota/storage
 * failures never leave the user on an empty annotate page.
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
  const base: PendingCaptureBase = {
    id: nextScreenshotId(capturedAt),
    imageDataUrl,
    capturedAt,
    url: tab.url,
    title: tab.title,
    viewport,
    tabId,
  };

  let pending: PendingCapture;
  try {
    pending = deps.finalizePending
      ? await deps.finalizePending(base)
      : { ...base, kind: "screenshot" };
  } catch (error) {
    return { ok: false, error: describe(error) };
  }

  const validated = parsePendingCapture(pending);
  if (!validated) {
    return {
      ok: false,
      error: "Could not prepare the capture for annotation. Try again.",
    };
  }

  try {
    await deps.setPending(validated);
  } catch (error) {
    return {
      ok: false,
      error: `Could not store the capture for annotation: ${describe(error)}`,
    };
  }

  try {
    await deps.openEditor();
  } catch (error) {
    // Pending is parked; still surface open failure so the caller is not silent.
    return {
      ok: false,
      error: `Capture saved but the editor could not be opened: ${describe(error)}`,
    };
  }

  return { ok: true, id: validated.id };
}

/** Reads the parked capture, or null when missing/invalid. */
export async function readPendingScreenshot(): Promise<PendingCapture | null> {
  const stored = await chrome.storage.session.get(PENDING_KEY);
  return parsePendingCapture(stored?.[PENDING_KEY]);
}

/**
 * Parks a validated capture. Throws on storage failure so callers can avoid
 * opening the editor.
 */
export async function writePendingScreenshot(pending: PendingCapture): Promise<void> {
  const validated = parsePendingCapture(pending);
  if (!validated) {
    throw new Error("Invalid pending capture payload.");
  }
  await chrome.storage.session.set({ [PENDING_KEY]: validated });
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
  pending: PendingCapture,
  annotated: Screenshot,
): { screenshot: Screenshot; imageDataUrl: string } {
  const caption = defaultCaptionForPending(pending, annotated.caption);
  return {
    screenshot: {
      ...annotated,
      id: pending.id,
      capturedAt: pending.capturedAt,
      url: pending.url,
      title: pending.title,
      viewport: pending.viewport,
      caption,
    },
    imageDataUrl: pending.imageDataUrl,
  };
}
