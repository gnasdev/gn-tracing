/**
 * The screenshot-report flow: capture → annotate → package → upload.
 *
 * A screenshot report is the cheap path. Most bug reports are "this looks
 * wrong, here", and forcing someone through a video recording to say that costs
 * them a minute and costs the reader a video to scrub. Jam separates the two
 * for the same reason.
 *
 * The annotate still lives in `chrome.storage.session` (small). Instant Replay
 * freeze (DOM lookback + evidence) lives in IndexedDB because session quota is
 * ~10MB and a full IR window can exceed that. Session/IDB outlive the MV3
 * service worker between capture and save.
 *
 * Instant Replay reuses the same annotate path: freeze lookback at capture,
 * park still + freeze, open the editor, package only on Save.
 */

import type { InstantReplayEvidenceBundle } from "../../packages/replay-core/src/capture/instant-replay-evidence";
import type {
  InstantReplayArtifact,
  Screenshot,
} from "../../packages/replay-core/src/schema/annotation";
import type { DomSnapshot } from "../../packages/replay-core/src/schema/capture";
import { hasInstantReplayFrames } from "../shared/instant-replay-policy";
import {
  clearPendingDomSnapshot,
  clearPendingIrFreeze,
  getPendingDomSnapshot,
  getPendingIrFreeze,
  putPendingDomSnapshot,
  putPendingIrFreeze,
} from "./pending-ir-freeze-idb";

/** Parked still + metadata for the annotate editor (and save handshake). */
export const PENDING_SCREENSHOT_KEY = "gn_tracing_pending_screenshot";
const PENDING_KEY = PENDING_SCREENSHOT_KEY;
/** Legacy session key — cleared on write/clear so old large freezes free quota. */
const LEGACY_PENDING_IR_FREEZE_KEY = "gn_tracing_pending_ir_freeze";
/** Set when the SW opens annotate so the popup can avoid a second tab. */
export const ANNOTATE_OPENED_AT_KEY = "gn_tracing_annotate_opened_at";

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
 * - `screenshot`: still + optional one-shot DOM (`dom.json`). No IR lookback,
 *   no console/network.
 * - `instant-replay`: still + frozen lookback (+ evidence) required at park time.
 */
export type PendingCapture =
  | (PendingCaptureBase & {
      kind: "screenshot";
      /** One-shot page DOM at capture time; parked in IndexedDB with the still. */
      frozenDom?: DomSnapshot | null;
    })
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
    const frozenDom = parseOptionalDomSnapshot(raw.frozenDom);
    return {
      ...base,
      kind: "screenshot",
      frozenDom: frozenDom ?? undefined,
    };
  }

  return null;
}

function parseOptionalDomSnapshot(value: unknown): DomSnapshot | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as DomSnapshot;
  if (!raw.root || typeof raw.root !== "object") {
    return null;
  }
  if (typeof raw.capturedAt !== "number") {
    return null;
  }
  return {
    label: typeof raw.label === "string" ? raw.label : "screenshot",
    capturedAt: raw.capturedAt,
    documentUrl: typeof raw.documentUrl === "string" ? raw.documentUrl : "",
    root: raw.root,
  };
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
 * Instant Replay reports always use the freeze (DOM + evidence).
 * Plain screenshots never attach lookback — still image only.
 */
export function resolveInstantReplayForSave(
  pending: PendingCapture,
  _options?: {
    /** @deprecated Ignored — screenshots no longer live-collect IR. */
    instantReplayEnabled?: boolean;
    /** @deprecated Ignored — screenshots no longer live-collect IR. */
    liveCollect?: () => Promise<
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

  // Screenshot reports are still-only: never piggyback Instant Replay frames.
  return Promise.resolve({ mode: "none" });
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

/** Still + kind for the annotate editor (no frozen IR lookback). */
export type AnnotatePendingView = PendingCaptureBase & {
  kind: PendingCapture["kind"];
};

/**
 * Still-only view of a parked capture for the annotate editor.
 * Omits multi-MB frozen IR lookback (loaded only on save).
 */
export function toAnnotatePendingView(pending: PendingCapture): AnnotatePendingView {
  return {
    id: pending.id,
    imageDataUrl: pending.imageDataUrl,
    capturedAt: pending.capturedAt,
    url: pending.url,
    title: pending.title,
    viewport: pending.viewport,
    tabId: pending.tabId,
    kind: pending.kind,
  };
}

/**
 * Parse the parked still for the annotate page.
 * Accepts IR still meta without freeze — freeze is only required on save.
 */
export function parsePendingStillView(value: unknown): AnnotatePendingView | null {
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
  if (vp.width <= 0 || vp.height <= 0) {
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

  if (raw.kind === "instant-replay") {
    return { ...base, kind: "instant-replay" };
  }
  if (raw.kind === "screenshot" || raw.kind == null) {
    return { ...base, kind: "screenshot" };
  }
  return null;
}

/**
 * Read only the still for the annotate editor.
 * Does not touch the IR freeze key — so a large/corrupt freeze cannot blank the image.
 */
export async function readPendingStillForAnnotate(): Promise<AnnotatePendingView | null> {
  const stored = await chrome.storage.session.get(PENDING_KEY);
  return parsePendingStillView(stored?.[PENDING_KEY]);
}

/** Reads the full parked capture (reassembles IR freeze / DOM from IndexedDB). */
export async function readPendingScreenshot(): Promise<PendingCapture | null> {
  const stored = await chrome.storage.session.get(PENDING_KEY);
  const raw = stored?.[PENDING_KEY];
  if (!raw) {
    return null;
  }

  // Legacy: freeze embedded on the same session object.
  const direct = parsePendingCapture(raw);
  if (direct?.kind === "instant-replay") {
    return direct;
  }

  // Still in session + bulk payload in IndexedDB (current layout).
  const still = parsePendingStillView(raw);
  if (still?.kind === "instant-replay") {
    const freeze = await getPendingIrFreeze(still.id);
    if (freeze) {
      return parsePendingCapture({
        ...still,
        kind: "instant-replay",
        frozenInstantReplay: freeze,
      });
    }
    return null;
  }

  if (still?.kind === "screenshot" || direct?.kind === "screenshot") {
    const base = still ?? direct!;
    const frozenDom =
      (direct?.kind === "screenshot" ? direct.frozenDom : null) ??
      (await getPendingDomSnapshot(base.id));
    return {
      ...base,
      kind: "screenshot",
      frozenDom: frozenDom ?? undefined,
    };
  }

  return direct;
}

/**
 * Parks a validated capture. Throws on storage failure so callers can avoid
 * opening the editor.
 *
 * Still → session storage (small). IR freeze / DOM snapshot → IndexedDB.
 */
export async function writePendingScreenshot(pending: PendingCapture): Promise<void> {
  const validated = parsePendingCapture(pending);
  if (!validated) {
    throw new Error("Invalid pending capture payload.");
  }

  // Drop any legacy multi-MB freeze left in session from older builds.
  await chrome.storage.session.remove(LEGACY_PENDING_IR_FREEZE_KEY);

  if (validated.kind === "instant-replay") {
    const stillMeta = toAnnotatePendingView(validated);
    await chrome.storage.session.set({ [PENDING_KEY]: stillMeta });
    try {
      await putPendingIrFreeze(validated.id, validated.frozenInstantReplay);
    } catch (error) {
      await chrome.storage.session.remove([PENDING_KEY, ANNOTATE_OPENED_AT_KEY]);
      await clearPendingIrFreeze(validated.id).catch(() => undefined);
      throw new Error(`Could not store Instant Replay lookback for annotation: ${describe(error)}`);
    }
    await clearPendingDomSnapshot(validated.id).catch(() => undefined);
    return;
  }

  // Screenshot: still meta in session; one-shot DOM (when present) in IndexedDB.
  const stillMeta = toAnnotatePendingView(validated);
  await chrome.storage.session.set({ [PENDING_KEY]: stillMeta });
  await clearPendingIrFreeze(validated.id).catch(() => undefined);
  if (validated.frozenDom) {
    try {
      await putPendingDomSnapshot(validated.id, validated.frozenDom);
    } catch (error) {
      await chrome.storage.session.remove([PENDING_KEY, ANNOTATE_OPENED_AT_KEY]);
      await clearPendingDomSnapshot(validated.id).catch(() => undefined);
      throw new Error(`Could not store screenshot DOM snapshot: ${describe(error)}`);
    }
  } else {
    await clearPendingDomSnapshot(validated.id).catch(() => undefined);
  }
}

/**
 * Clears the parked capture (still + IR freeze + DOM snapshot).
 *
 * Always called after a save or a discard: the image is a picture of the user's
 * screen and there is no reason for it to outlive the report it belongs to.
 */
export async function clearPendingScreenshot(): Promise<void> {
  let pendingId: string | undefined;
  try {
    const stored = await chrome.storage.session.get(PENDING_KEY);
    const still = parsePendingStillView(stored?.[PENDING_KEY]);
    pendingId = still?.id;
  } catch {
    // Best-effort id lookup before wipe.
  }

  await chrome.storage.session.remove([
    PENDING_KEY,
    LEGACY_PENDING_IR_FREEZE_KEY,
    ANNOTATE_OPENED_AT_KEY,
  ]);
  if (pendingId) {
    await clearPendingIrFreeze(pendingId).catch(() => undefined);
    await clearPendingDomSnapshot(pendingId).catch(() => undefined);
  } else {
    await clearPendingIrFreeze().catch(() => undefined);
    await clearPendingDomSnapshot().catch(() => undefined);
  }
}

/** Opens the annotate editor tab and records a short-lived "opened" marker. */
export async function openAnnotateEditorTab(
  createTab: (url: string) => Promise<{ windowId?: number } | undefined> = async (url) =>
    chrome.tabs.create({ url, active: true }),
  focusWindow: (windowId: number) => Promise<unknown> = (windowId) =>
    chrome.windows.update(windowId, { focused: true }),
  markOpened: () => Promise<void> = async () => {
    await chrome.storage.session.set({ [ANNOTATE_OPENED_AT_KEY]: Date.now() });
  },
  getEditorUrl: () => string = () => chrome.runtime.getURL("annotate/annotate.html"),
): Promise<void> {
  const tab = await createTab(getEditorUrl());
  if (typeof tab?.windowId === "number") {
    try {
      await focusWindow(tab.windowId);
    } catch {
      // Focusing is best-effort; the tab itself is what matters.
    }
  }
  try {
    await markOpened();
  } catch {
    // Marker is only for popup dedupe; the editor tab is already open.
  }
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
