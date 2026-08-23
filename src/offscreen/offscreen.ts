/**
 * Runs tab media capture and cloud storage upload work in an offscreen document.
 */

import type { Screenshot } from "../../packages/replay-core/src/schema/annotation";
import type { PackageMetadata } from "../../packages/replay-core/src/schema/package";
import {
  type AttachableArtifactId,
  buildRecordingPackage,
} from "../../packages/replay-core/src/write";
import { getScreenshotPackageStaging } from "../background/screenshot-package-staging-idb";
import { acquireMicrophoneStream, mixCaptureAudio } from "../media-pipeline/audio-capture";
import type { CapturedSurface } from "../media-pipeline/capture-surface";
import {
  acquireCaptureStream,
  describeDisplayCaptureError,
  pickRecorderMimeType,
  type SessionRecordingSnapshot,
  stopRecorderAndWaitForFlush,
  waitForFirstFrame,
} from "../media-pipeline/record-session";
import { getProducerCapabilities } from "../platform/capabilities";
import { isMediaMessageTarget, MEDIA_PAGE_MESSAGE_TARGET } from "../platform/media/message-target";
import { getProductVersionOrDefault } from "../shared/app-version";
import {
  DROPBOX_UPLOAD_SESSION_THRESHOLD_BYTES,
  makeDropboxPublicReadable,
  resolveDropboxFolderPath,
  uploadDropboxFile,
} from "../shared/dropbox-api";
import {
  GOOGLE_DRIVE_RESUMABLE_THRESHOLD_BYTES,
  makeGoogleDrivePublicReadable,
  resolveGoogleDriveFolderPath,
  uploadGoogleDriveFile,
} from "../shared/google-drive-api";
import { buildExternalPlayerUrl } from "../shared/player-host";
import {
  ADOPT_DISPLAY_STREAM_MESSAGE,
  ADOPT_DISPLAY_STREAM_RESULT,
} from "../shared/popup-display-capture";
import {
  hasRecordingHostPermission,
  RECORDING_HOST_ORIGINS,
  requestRecordingHostPermission,
} from "../shared/recording-host-permission";
import type { StorageProviderId } from "../shared/storage-provider";
import { makeWebmSeekable } from "../shared/webm-seek-fix";
import type { ProgressItemSnapshot, ProgressItemStatus } from "../types/messages";
import { createAgentSummaryBlob } from "./agent-summary";
import { buildScreenshotPackage, type ScreenshotInput } from "./screenshot-package";

/**
 * Offscreen document runtime for media capture and multi-cloud package uploads.
 *
 * MV3 service workers cannot own a MediaRecorder or long-lived MediaStream, so
 * this document holds the active tab stream, final recording snapshots, and the
 * upload pipeline. The service worker communicates with it through runtime
 * messages and treats this file as the media/upload worker.
 *
 * Provider-specific I/O uses shared modules (`google-drive-api`, `dropbox-api`)
 * so adapters and this path cannot diverge on share/upload rules.
 */
let recorder: MediaRecorder | null = null;
let activeChunks: Blob[] = [];
let activeSessionId: string | null = null;
let activeStream: MediaStream | null = null;
let activeMicrophoneStream: MediaStream | null = null;
let activeAudioMixCleanup: (() => Promise<void>) | null = null;
let activeMixedInputTracks: MediaStreamTrack[] = [];
let playbackAudioContext: AudioContext | null = null;
let playbackSourceNode: MediaStreamAudioSourceNode | null = null;
let shouldDiscardActiveCapture = false;

/**
 * Emit a chunk every second instead of buffering the whole recording until stop.
 * Data then accumulates in `activeChunks` as the recording runs, so a lost final
 * flush costs at most the last second rather than the entire video.
 */
const RECORDER_TIMESLICE_MS = 1000;

/** How long to wait for the recorder's `stop` event to deliver its last chunk. */
const RECORDER_FLUSH_TIMEOUT_MS = 5000;

/** Resolves once the recorder's `stop` handler has finished building the blob. */
let recorderFlush: { promise: Promise<void>; resolve: () => void } | null = null;

/** Recorder failure text for the active session, surfaced when upload finds no blob. */
let activeRecorderError: string | null = null;

/** Mime type of the in-flight recorder, needed by the timeout finalize path. */
let activeRecorderMimeType = "";

/**
 * Sessions already finalized, so the `stop` event and the flush timeout cannot
 * both build a snapshot (or both report RECORDING_COMPLETE) for one recording.
 */
const finalizedSessionIds = new Set<string>();

const sessionSnapshots = new Map<string, SessionRecordingSnapshot>();

/**
 * Sessions whose recorder finished without producing any bytes.
 *
 * Kept apart from `sessionSnapshots` so upload can say "no video was produced"
 * instead of the misleading "snapshot is no longer available", which reads as if
 * a good recording had expired.
 */
const emptyRecordingSessions = new Map<string, string>();

function createFlushDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface OffscreenIncomingMessage {
  target: string;
  type: string;
  data?: Record<string, unknown>;
}

interface ZipData {
  consoleLogs?: string;
  networkRequests?: string;
  webSocketLogs?: string;
  report?: string;
  userEvents?: string;
  drawing?: string;
  privacy?: string;
  diagnostics?: string;
  storage?: string;
  dom?: string;
  screenshotDataUrl?: string | null;
  evidenceCoverage?: import("../../packages/replay-core/src/schema/package").EvidenceCoverage;
  duration: number;
  url: string;
  startTime: number | null;
  sessionId: string;
}

interface StorageUploadData extends ZipData {
  authToken: string;
  targetFolderId?: string | null;
  targetFolderPath?: string[];
  zipPassword?: string | null;
  /**
   * Registered storage provider that performs I/O. Must match the token and
   * metadata.storage.provider (service worker clamps via resolveRegisteredUploadProviderId).
   */
  storageProvider?: StorageProviderId;
  artifactKeys?: {
    consoleLogs?: boolean;
    networkRequests?: boolean;
    webSocketLogs?: boolean;
    report?: boolean;
    userEvents?: boolean;
    drawing?: boolean;
    privacy?: boolean;
    diagnostics?: boolean;
    storage?: boolean;
    dom?: boolean;
    screenshot?: boolean;
  };
}

type UploadArtifactKey =
  | "consoleLogs"
  | "networkRequests"
  | "webSocketLogs"
  | "report"
  | "userEvents"
  | "drawing"
  | "privacy"
  | "diagnostics"
  | "storage"
  | "dom";

interface UploadArtifactChunkResponse {
  ok: boolean;
  chunk?: string;
  nextOffset?: number;
  totalLength?: number;
  error?: string;
}

interface UploadProgressSnapshot {
  sessionId: string;
  step: number;
  total: number;
  percent: number;
  uploadedBytes: number;
  totalBytes: number;
  message: string;
  items: ProgressItemSnapshot[];
}

/** Shared with GoogleDriveProvider via google-drive-api (single source of truth). */
const MAX_DRIVE_UPLOAD_BYTES = GOOGLE_DRIVE_RESUMABLE_THRESHOLD_BYTES;
/** Shared with DropboxProvider via dropbox-api. */
const MAX_DROPBOX_SIMPLE_UPLOAD_BYTES = DROPBOX_UPLOAD_SESSION_THRESHOLD_BYTES;
/** Zip video part size — keep under provider simple-upload thresholds where practical. */
const MAX_PACKAGE_PART_BYTES = Math.min(MAX_DRIVE_UPLOAD_BYTES, MAX_DROPBOX_SIMPLE_UPLOAD_BYTES);
const UPLOAD_PROGRESS_THROTTLE_MS = 250;
const UPLOAD_PROGRESS_MIN_DELTA = 0.5;

// Chromium hosts this document via chrome.offscreen; Firefox opens the same
// page as a tab. Accept both historical "offscreen" and "media-host" targets.
chrome.runtime.onMessage.addListener((message: OffscreenIncomingMessage, _sender, sendResponse) => {
  if (!isMediaMessageTarget(message.target)) {
    return false;
  }

  switch (message.type) {
    case "START_CAPTURE":
      startCapture(
        String(message.data?.streamId || ""),
        String(message.data?.sessionId || ""),
        String(message.data?.mode || ""),
        {
          microphoneEnabled: message.data?.microphoneEnabled !== false,
          microphoneDeviceId: String(message.data?.microphoneDeviceId || ""),
        },
      )
        .then((firstFrameAt) => sendResponse({ ok: true, data: { firstFrameAt } }))
        .catch((error: Error) => sendResponse({ ok: false, error: error.message }));
      return true;

    case "START_TAB_FRAME_CAPTURE":
      // Firefox preferred path: tabs.captureTab → canvas stream (no share picker).
      startTabFrameCapture(Number(message.data?.tabId), String(message.data?.sessionId || ""), {
        microphoneEnabled: message.data?.microphoneEnabled !== false,
        microphoneDeviceId: String(message.data?.microphoneDeviceId || ""),
      })
        .then((result) => sendResponse({ ok: true, data: result }))
        .catch((error: Error) => sendResponse({ ok: false, error: error.message }));
      return true;

    case "ARM_DISPLAY_CAPTURE":
      // Firefox fallback only: getDisplayMedia when tab-frame capture is unavailable.
      armDisplayCapture({
        sessionId: String(message.data?.sessionId || ""),
        microphoneEnabled: message.data?.microphoneEnabled !== false,
        microphoneDeviceId: String(message.data?.microphoneDeviceId || ""),
        tabTitle: typeof message.data?.tabTitle === "string" ? message.data.tabTitle : "",
      });
      sendResponse({ ok: true });
      return false;

    case "MEDIA_HOST_PING":
      sendResponse({ ok: true });
      return false;

    case "CANCEL_DISPLAY_CAPTURE":
      disarmDisplayCapture();
      sendResponse({ ok: true });
      return false;

    case "STOP_CAPTURE":
      stopCapture()
        .then(() => sendResponse({ ok: true }))
        .catch((error: Error) => sendResponse({ ok: false, error: error.message }));
      return true;

    case "DISCARD_CAPTURE":
      discardCapture()
        .then(() => sendResponse({ ok: true }))
        .catch((error: Error) => sendResponse({ ok: false, error: error.message }));
      return true;

    case "DELETE_SESSION_SNAPSHOT":
      deleteSessionSnapshot(String(message.data?.sessionId || ""));
      sendResponse({ ok: true });
      return false;

    case "GET_CAPTURE_STATE":
      sendResponse({
        ok: true,
        isRecording: Boolean(recorder && recorder.state !== "inactive"),
        activeSessionId,
        snapshotSessionIds: Array.from(sessionSnapshots.keys()),
      });
      return false;

    case "UPLOAD_TO_STORAGE":
    case "UPLOAD_TO_GOOGLE_DRIVE":
      // UPLOAD_TO_GOOGLE_DRIVE is a legacy alias; storageProvider in data selects backend.
      uploadRecordingPackage(message.data as unknown as StorageUploadData)
        .then((result) => sendResponse(result))
        .catch((error: Error) => sendResponse({ ok: false, error: error.message }));
      return true;

    case "UPLOAD_SCREENSHOT_PACKAGE":
      uploadScreenshotPackage(message.data as unknown as ScreenshotUploadData)
        .then((result) => sendResponse(result))
        .catch((error: Error) => sendResponse({ ok: false, error: error.message }));
      return true;

    default:
      return false;
  }
});

function sendProgress(progress: UploadProgressSnapshot): void {
  chrome.runtime.sendMessage({
    target: "offscreen",
    type: "UPLOAD_PROGRESS",
    data: progress,
  });
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, value));
}

async function stopActiveMediaStream(): Promise<void> {
  stopTabFramePump();

  if (activeAudioMixCleanup) {
    const cleanup = activeAudioMixCleanup;
    activeAudioMixCleanup = null;
    await cleanup().catch(() => {});
  }
  activeMixedInputTracks.forEach((track) => {
    track.stop();
  });
  activeMixedInputTracks = [];
  if (activeMicrophoneStream) {
    activeMicrophoneStream.getTracks().forEach((track) => {
      track.stop();
    });
    activeMicrophoneStream = null;
  }
  if (playbackSourceNode) {
    playbackSourceNode.disconnect();
    playbackSourceNode = null;
  }

  if (activeStream) {
    activeStream.getTracks().forEach((track) => {
      track.stop();
    });
    activeStream = null;
  }

  if (playbackAudioContext) {
    const context = playbackAudioContext;
    playbackAudioContext = null;
    await context.close().catch(() => {});
  }
}

function clearActiveCapture(): void {
  stopTabFramePump();
  activeChunks = [];
  activeSessionId = null;
  shouldDiscardActiveCapture = false;

  if (recorder) {
    recorder.ondataavailable = null;
    recorder.onstop = null;
    recorder = null;
  }

  void stopActiveMediaStream();
}

/**
 * Firefox preferred video path: snapshot the recorded tab on an interval and
 * feed a canvas MediaStream. Selects the Start tab by id — no share picker,
 * no "Choose what to share" arm panel, and no window/screen over-capture.
 *
 * Requires `tabs.captureTab` (Firefox) or fails so the host can fall back to
 * getDisplayMedia. Motion looks stepped vs real-time capture; that trade-off is
 * recorded in package limitations by the runtime.
 */
type TabFramePump = { stop: () => void };
let tabFramePump: TabFramePump | null = null;

const TAB_FRAME_INTERVAL_MS = 100;
const TAB_FRAME_JPEG_QUALITY = 70;

type CaptureTabOptions = { format?: string; quality?: number };

/**
 * Promisified tabs.captureTab. Firefox's chrome.* namespace is often callback-
 * based; awaiting the raw return yields undefined and forced the getDisplayMedia
 * arm-panel fallback. Also try browser.tabs when present.
 */
function getCaptureTabApi():
  | ((tabId: number, options?: CaptureTabOptions) => Promise<string>)
  | null {
  const chromeTabs = chrome.tabs as typeof chrome.tabs & {
    captureTab?: (
      tabId: number,
      options?: CaptureTabOptions,
      callback?: (dataUrl: string) => void,
    ) => Promise<string> | undefined;
  };
  const browserTabs = (
    globalThis as unknown as {
      browser?: { tabs?: { captureTab?: typeof chromeTabs.captureTab } };
    }
  ).browser?.tabs;

  const captureTab = browserTabs?.captureTab ?? chromeTabs.captureTab;
  if (typeof captureTab !== "function") {
    return null;
  }

  return (tabId, options) =>
    new Promise<string>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        fn();
      };

      let maybePromise: unknown;
      try {
        maybePromise = captureTab(tabId, options, (dataUrl: string) => {
          const err = chrome.runtime?.lastError?.message;
          if (err) {
            finish(() => reject(new Error(err)));
            return;
          }
          finish(() => resolve(dataUrl));
        });
      } catch (error) {
        finish(() => reject(error instanceof Error ? error : new Error(String(error))));
        return;
      }

      // Promise-style API (browser.* or modern chrome.*).
      if (maybePromise && typeof (maybePromise as Promise<string>).then === "function") {
        void (maybePromise as Promise<string>).then(
          (dataUrl) => finish(() => resolve(dataUrl)),
          (error) =>
            finish(() => reject(error instanceof Error ? error : new Error(String(error)))),
        );
      }
    });
}

function stopTabFramePump(): void {
  if (!tabFramePump) {
    return;
  }
  tabFramePump.stop();
  tabFramePump = null;
}

async function dataUrlToImageBitmap(dataUrl: string): Promise<ImageBitmap> {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  return createImageBitmap(blob);
}

async function startTabFrameCapture(
  tabId: number,
  sessionId: string,
  audioOptions: CaptureAudioOptions = {},
): Promise<{ firstFrameAt: number | null; surface: CapturedSurface }> {
  if (!sessionId || !Number.isFinite(tabId) || tabId <= 0) {
    throw new Error("Missing tab-frame capture session metadata.");
  }
  if (recorder && recorder.state !== "inactive") {
    throw new Error("A recording is already active.");
  }

  const captureTab = getCaptureTabApi();
  if (!captureTab) {
    throw new Error("tabs.captureTab is not available in this browser.");
  }

  // Fail fast before arming MediaRecorder if the tab cannot be snapshotted.
  const firstDataUrl = await captureTab(tabId, {
    format: "jpeg",
    quality: TAB_FRAME_JPEG_QUALITY,
  });
  if (!firstDataUrl) {
    throw new Error("Could not capture a frame from the recorded tab.");
  }

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) {
    throw new Error("Could not create a canvas for tab-frame capture.");
  }

  const firstBitmap = await dataUrlToImageBitmap(firstDataUrl);
  canvas.width = firstBitmap.width || 1280;
  canvas.height = firstBitmap.height || 720;
  ctx.drawImage(firstBitmap, 0, 0);
  firstBitmap.close();

  // 10 fps target; actual rate is gated by captureTab latency.
  const stream = canvas.captureStream(10);
  let stopped = false;
  let inFlight = false;

  const tick = async () => {
    if (stopped || inFlight) {
      return;
    }
    inFlight = true;
    try {
      const dataUrl = await captureTab(tabId, {
        format: "jpeg",
        quality: TAB_FRAME_JPEG_QUALITY,
      });
      if (!dataUrl || stopped) {
        return;
      }
      const bitmap = await dataUrlToImageBitmap(dataUrl);
      if (stopped) {
        bitmap.close();
        return;
      }
      if (
        bitmap.width > 0 &&
        bitmap.height > 0 &&
        (canvas.width !== bitmap.width || canvas.height !== bitmap.height)
      ) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
      }
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
    } catch {
      // Tab may be restricted mid-session; keep the last good frame.
    } finally {
      inFlight = false;
    }
  };

  const intervalId = setInterval(() => {
    void tick();
  }, TAB_FRAME_INTERVAL_MS);

  stopTabFramePump();
  tabFramePump = {
    stop: () => {
      stopped = true;
      clearInterval(intervalId);
    },
  };

  try {
    const firstFrameAt = await startCaptureWithStream(stream, sessionId, false, audioOptions);
    return {
      firstFrameAt,
      surface: { displaySurface: "browser", label: "Recorded tab" },
    };
  } catch (error) {
    stopTabFramePump();
    throw error;
  }
}

/**
 * Firefox display-capture arming.
 *
 * `getDisplayMedia` needs transient user activation, which a background message
 * cannot supply — hence the visible button. The panel stays hidden on Chromium,
 * where this document is an offscreen document driven by chrome.tabCapture.
 */
type ArmedDisplayCapture = CaptureAudioOptions & { sessionId: string };

let armedDisplayCapture: ArmedDisplayCapture | null = null;
let armWired = false;

function armPanelElements() {
  return {
    panel: document.getElementById("arm-panel"),
    button: document.getElementById("arm-btn") as HTMLButtonElement | null,
    cancelButton: document.getElementById("arm-cancel-btn") as HTMLButtonElement | null,
    status: document.getElementById("arm-status"),
    target: document.getElementById("arm-target"),
    grant: document.getElementById("arm-grant"),
    grantButton: document.getElementById("arm-grant-btn") as HTMLButtonElement | null,
  };
}

/**
 * Show the grant step only when it is actually needed.
 *
 * Firefox MV3 treats every `host_permissions` entry as optional and not granted,
 * so on a site outside the manifest the only access is `activeTab` — which Firefox
 * revokes the moment this media tab takes focus. That is why injections after the
 * focus switch failed with "Missing host permission for the tab".
 *
 * When the popup already pre-requested host permission on Start, this stays hidden.
 */
async function refreshGrantStep(): Promise<void> {
  const { grant } = armPanelElements();
  if (!grant) {
    return;
  }
  grant.hidden = await hasRecordingHostPermission();
}

/**
 * Ask for the host permission in its own click.
 *
 * It cannot share the click that starts capture: awaiting the permission prompt
 * consumes the transient activation, and `getDisplayMedia` would then fail with
 * InvalidStateError. Two buttons, two gestures. Prefer the popup Start gesture
 * when possible so this step is skipped entirely.
 */
async function onGrantButtonClick(): Promise<void> {
  const { grant, grantButton } = armPanelElements();
  if (grantButton) {
    grantButton.disabled = true;
  }
  setArmStatus("");

  try {
    const granted = await requestRecordingHostPermission();
    if (granted) {
      if (grant) {
        grant.hidden = true;
      }
      return;
    }
    setArmStatus(
      "Site access was declined. The video still records, but console and network " +
        "evidence will be missing. You can grant it later in about:addons.",
    );
  } catch (error) {
    setArmStatus(
      `Could not request site access: ${(error as Error)?.message || String(error)}. ` +
        "Grant it in about:addons instead.",
    );
  } finally {
    if (grantButton) {
      grantButton.disabled = false;
    }
  }
}

// Keep the shared origins list referenced so arm-panel permission tests can
// still assert this document uses the same list as the manifest.
const _recordingHostOriginsForArmPanel = RECORDING_HOST_ORIGINS;
void _recordingHostOriginsForArmPanel;

function setArmStatus(message: string): void {
  const { status } = armPanelElements();
  if (status) {
    status.textContent = message;
  }
}

function sendDisplayCaptureResult(result: {
  sessionId: string;
  ok: boolean;
  firstFrameAt?: number | null;
  cancelled?: boolean;
  error?: string;
  surface?: CapturedSurface;
}): void {
  // Fire-and-forget: the background may have already given up (arm timeout).
  void chrome.runtime
    .sendMessage({
      target: MEDIA_PAGE_MESSAGE_TARGET,
      type: "DISPLAY_CAPTURE_RESULT",
      data: result,
    })
    .catch(() => {
      // Background listener gone — nothing useful to do here.
    });
}

function disarmDisplayCapture(): void {
  armedDisplayCapture = null;
  const { panel, button } = armPanelElements();
  if (panel) {
    panel.hidden = true;
  }
  if (button) {
    button.disabled = false;
  }
  setArmStatus("");
}

async function onArmButtonClick(options?: { auto?: boolean }): Promise<boolean> {
  const armed = armedDisplayCapture;
  if (!armed) {
    return false;
  }
  const auto = Boolean(options?.auto);
  const { button } = armPanelElements();
  if (button) {
    button.disabled = true;
  }
  if (!auto) {
    setArmStatus("");
  }

  try {
    // Prefer calling this from a real click so transient activation holds.
    // Auto-start (no click) is attempted first; if the engine blocks it, the
    // button is shown again for a manual gesture — without failing the session.
    const firstFrameAt = await startCapture("", armed.sessionId, "display-media", armed);
    // Read the surface before disarming: it is what the user actually picked, and
    // Firefox can only offer a window or a screen, never the recorded tab alone.
    const surface = readCapturedSurface(activeStream);
    armedDisplayCapture = null;
    disarmDisplayCapture();
    sendDisplayCaptureResult({
      sessionId: armed.sessionId,
      ok: true,
      firstFrameAt,
      surface,
    });
    return true;
  } catch (error) {
    const failure = describeDisplayCaptureError(error);
    if (button) {
      button.disabled = false;
    }

    // Auto-start blocked (no gesture / NotAllowedError): keep session armed and
    // let the user click. Do not report failure to the background yet.
    if (auto) {
      return false;
    }

    // Cancelling closes the panel; a real failure keeps it open so the user can
    // read the reason and retry without restarting from the popup.
    if (failure.cancelled) {
      armedDisplayCapture = null;
      disarmDisplayCapture();
    } else {
      setArmStatus(failure.message);
    }
    sendDisplayCaptureResult({
      sessionId: armed.sessionId,
      ok: false,
      cancelled: failure.cancelled,
      error: failure.message,
    });
    return false;
  }
}

/**
 * Preferred Firefox path: popup opened getDisplayMedia and transferred tracks.
 * Start MediaRecorder without focusing this tab or showing the arm panel.
 */
async function adoptDisplayStreamFromPopup(input: {
  sessionId: string;
  tracks: MediaStreamTrack[];
  microphoneEnabled?: boolean;
  microphoneDeviceId?: string;
  source: MessageEventSource | null;
  origin: string;
}): Promise<void> {
  const reply = (payload: {
    ok: boolean;
    firstFrameAt?: number | null;
    cancelled?: boolean;
    error?: string;
    surface?: CapturedSurface;
  }) => {
    const target = input.source as Window | null;
    if (target && typeof target.postMessage === "function") {
      try {
        target.postMessage(
          {
            type: ADOPT_DISPLAY_STREAM_RESULT,
            sessionId: input.sessionId,
            ...payload,
          },
          input.origin,
        );
      } catch {
        // Popup may have closed; runtime result still helps the SW path.
      }
    }
    sendDisplayCaptureResult({
      sessionId: input.sessionId,
      ok: payload.ok,
      firstFrameAt: payload.firstFrameAt,
      cancelled: payload.cancelled,
      error: payload.error,
      surface: payload.surface,
    });
  };

  if (!input.sessionId || !Array.isArray(input.tracks) || input.tracks.length === 0) {
    reply({
      ok: false,
      error: "Missing display stream tracks from the popup.",
    });
    return;
  }

  try {
    // Drop arm UI if a fallback arm was in flight.
    armedDisplayCapture = null;
    disarmDisplayCapture();
    const stream = new MediaStream(input.tracks);
    const firstFrameAt = await startCaptureWithStream(stream, input.sessionId, false, input);
    const surface = readCapturedSurface(activeStream);
    reply({ ok: true, firstFrameAt, surface });
  } catch (error) {
    const failure = describeDisplayCaptureError(error);
    reply({
      ok: false,
      cancelled: failure.cancelled,
      error: failure.message,
    });
  }
}

function wirePopupDisplayStreamAdoption(): void {
  window.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as {
      type?: string;
      sessionId?: string;
      tracks?: MediaStreamTrack[];
      microphoneEnabled?: boolean;
      microphoneDeviceId?: string;
    } | null;
    if (!data || data.type !== ADOPT_DISPLAY_STREAM_MESSAGE) {
      return;
    }
    // Only accept from our own extension origin (popup / other extension pages).
    const extensionOrigin = chrome.runtime.getURL("").replace(/\/$/, "");
    if (event.origin !== extensionOrigin) {
      return;
    }
    void adoptDisplayStreamFromPopup({
      sessionId: String(data.sessionId || ""),
      tracks: Array.isArray(data.tracks) ? data.tracks : [],
      microphoneEnabled: data.microphoneEnabled !== false,
      microphoneDeviceId:
        typeof data.microphoneDeviceId === "string" ? data.microphoneDeviceId : "",
      source: event.source,
      origin: event.origin,
    });
  });
}

wirePopupDisplayStreamAdoption();

function armDisplayCapture(input: {
  sessionId: string;
  tabTitle: string;
  microphoneEnabled?: boolean;
  microphoneDeviceId?: string;
}): void {
  if (!input.sessionId) {
    return;
  }
  armedDisplayCapture = {
    sessionId: input.sessionId,
    microphoneEnabled: input.microphoneEnabled,
    microphoneDeviceId: input.microphoneDeviceId,
  };

  const { panel, button, cancelButton, target } = armPanelElements();
  if (!panel || !button) {
    // Chromium offscreen document has no arm markup and never arms.
    return;
  }

  if (!armWired) {
    armWired = true;
    button.addEventListener("click", () => {
      void onArmButtonClick({ auto: false });
    });
    armPanelElements().grantButton?.addEventListener("click", () => {
      void onGrantButtonClick();
    });
    cancelButton?.addEventListener("click", () => {
      const armed = armedDisplayCapture;
      disarmDisplayCapture();
      if (armed) {
        sendDisplayCaptureResult({
          sessionId: armed.sessionId,
          ok: false,
          cancelled: true,
          error: "Screen sharing was cancelled, so recording did not start.",
        });
      }
    });
  }

  if (target) {
    target.textContent = input.tabTitle
      ? `Recording target: ${input.tabTitle} — pick the Firefox window with this title`
      : "";
    target.hidden = !input.tabTitle;
  }

  // Open the OS share picker immediately — keep the arm panel hidden so the
  // user does not see an intermediate "Choose what to share" dialog. Only reveal
  // buttons if the engine blocks auto-start (no gesture in this document).
  button.hidden = true;
  button.disabled = true;
  panel.hidden = true;
  setArmStatus("");
  void onArmButtonClick({ auto: true }).then((ok) => {
    if (ok || !armedDisplayCapture) {
      return;
    }
    panel.hidden = false;
    button.hidden = false;
    button.disabled = false;
    setArmStatus("Click Choose what to share to open the browser picker.");
    void refreshGrantStep();
    button.focus();
  });
}

/**
 * What the browser says was actually captured.
 *
 * Firefox 153 omits `displaySurface` from `getSettings()` (measured: it is absent,
 * and `getSupportedConstraints().displaySurface` is false), but it does name the
 * surface in `track.label` — "Primary Monitor" for a whole screen, the window
 * title for a window. Chromium supplies `displaySurface` directly. Recording both
 * makes a "why is my whole desktop in the video" report self-diagnosing.
 */
function describeCapturedSurface(stream: MediaStream): string {
  const [track] = stream.getVideoTracks();
  if (!track) {
    return "no video track";
  }
  const settings = track.getSettings() as MediaTrackSettings & {
    displaySurface?: string;
  };
  const parts = [
    `label="${track.label || "(unnamed)"}"`,
    `displaySurface=${settings.displaySurface ?? "(absent)"}`,
    `size=${settings.width ?? "?"}x${settings.height ?? "?"}`,
  ];
  return parts.join(" ");
}

/**
 * The machine-readable form of the same signals, for the privacy limitations.
 *
 * Read from the live track rather than from the constraints we asked for: Firefox
 * ignores `displaySurface` and `preferCurrentTab`, so what we requested says
 * nothing about what the user actually picked.
 */
function readCapturedSurface(stream: MediaStream | null): CapturedSurface {
  const track = stream?.getVideoTracks()[0];
  if (!track) {
    return {};
  }
  const settings = track.getSettings() as MediaTrackSettings & {
    displaySurface?: string;
  };
  return {
    label: track.label || "",
    ...(settings.displaySurface ? { displaySurface: settings.displaySurface } : {}),
  };
}

async function startCapture(
  streamId: string,
  sessionId: string,
  mode = "",
  audioOptions: CaptureAudioOptions = {},
): Promise<number | null> {
  if (!sessionId) {
    throw new Error("Missing capture session metadata.");
  }
  if (mode !== "display-media" && !streamId) {
    throw new Error("Missing capture session metadata.");
  }

  const { stream, loopbackTabAudio } = await acquireCaptureStream(streamId, mode);
  return startCaptureWithStream(stream, sessionId, loopbackTabAudio, audioOptions);
}

type CaptureAudioOptions = {
  microphoneEnabled?: boolean;
  microphoneDeviceId?: string;
};

/**
 * Arm MediaRecorder on an already-acquired stream (tabCapture or popup handoff).
 */
async function startCaptureWithStream(
  inputStream: MediaStream,
  sessionId: string,
  loopbackTabAudio: boolean,
  audioOptions: CaptureAudioOptions = {},
): Promise<number | null> {
  if (!sessionId) {
    throw new Error("Missing capture session metadata.");
  }

  if (recorder && recorder.state !== "inactive") {
    throw new Error("A recording is already active.");
  }

  if (loopbackTabAudio) {
    // Tab capture audio must be piped to speakers so the user still hears the tab.
    playbackAudioContext = new AudioContext();
    const source = playbackAudioContext.createMediaStreamSource(inputStream);
    playbackSourceNode = source;
    source.connect(playbackAudioContext.destination);
  }

  activeMicrophoneStream = await acquireMicrophoneStream(
    audioOptions.microphoneDeviceId ?? "",
    audioOptions.microphoneEnabled !== false,
  );
  // inputStream carries the tab's own audio track when loopbackTabAudio is true
  // (Chromium tabCapture); mixCaptureAudio only pulls audio from this array, so
  // it must be included here or the recording ends up silent on tab audio.
  const audioInputs = [inputStream, ...(activeMicrophoneStream ? [activeMicrophoneStream] : [])];
  const mixedAudio = mixCaptureAudio(inputStream, audioInputs);
  if (mixedAudio.audioContext) {
    activeAudioMixCleanup = mixedAudio.cleanup;
    activeMixedInputTracks = inputStream.getAudioTracks();
  }
  const stream = mixedAudio.stream;

  const finalMimeType = pickRecorderMimeType(stream);

  recorder = new MediaRecorder(stream, finalMimeType ? { mimeType: finalMimeType } : undefined);
  activeStream = stream;
  activeSessionId = sessionId;
  activeChunks = [];
  shouldDiscardActiveCapture = false;
  activeRecorderError = null;
  // Read it back: when no mimeType was requested the browser resolved its own.
  activeRecorderMimeType = recorder.mimeType || finalMimeType || "video/webm";
  recorderFlush = createFlushDeferred();
  emptyRecordingSessions.delete(sessionId);
  finalizedSessionIds.delete(sessionId);

  console.info(
    `[GN Tracing] Recorder armed: mime="${activeRecorderMimeType}" ` +
      `tracks=${stream
        .getTracks()
        .map((track) => track.kind)
        .join("+")} ` +
      `surface: ${describeCapturedSurface(stream)}`,
  );

  recorder.ondataavailable = (event: BlobEvent) => {
    if (event.data.size > 0) {
      activeChunks.push(event.data);
    }
  };

  // Firefox can fail a recorder mid-session (source track died, encoder error).
  // Without this the failure is silent and only shows up as a zero-byte blob.
  recorder.onerror = (event: Event) => {
    const detail = (event as { error?: DOMException }).error;
    activeRecorderError = detail?.message || detail?.name || "The recorder reported an error.";
    console.error("[GN Tracing] MediaRecorder error:", detail ?? event);
  };

  recorder.onstop = () => {
    finalizeRecordingSnapshot("stop-event");
    clearActiveCapture();
    // Signals stopCapture that the final chunk has landed and the tracks may go.
    recorderFlush?.resolve();
  };

  // Timeslice keeps chunks flowing so the blob does not depend on one final flush.
  recorder.start(RECORDER_TIMESLICE_MS);
  const startedAt = Date.now();

  // Prefer the first produced video frame as video t=0. If that wait times out,
  // MediaRecorder.start() is still the media origin — do not fall back to a
  // later Date.now() after start() work in the service worker.
  return (await waitForFirstFrame(stream)) ?? startedAt;
}

/** Compact description of the capture's tracks — the useful bit when stop misbehaves. */
function describeActiveTracks(): string {
  const tracks = activeStream?.getTracks() ?? [];
  if (tracks.length === 0) {
    return "none";
  }
  return tracks
    .map((track) => `${track.kind}:${track.readyState}${track.muted ? ":muted" : ""}`)
    .join(",");
}

/**
 * Build and store the recording snapshot from whatever chunks have arrived.
 *
 * Deliberately does NOT depend on the recorder's `stop` event. Firefox has been
 * observed not firing `stop` for a `getDisplayMedia` capture whose page sits in a
 * background tab, and the whole recording used to be lost with it. Because the
 * recorder runs with a timeslice, `activeChunks` already holds everything except
 * the last second, so the timeout path can finalize too.
 *
 * Idempotent: whichever path runs first wins, the other is a no-op.
 */
function finalizeRecordingSnapshot(reason: "stop-event" | "flush-timeout"): void {
  const completedSessionId = activeSessionId;
  if (!completedSessionId || finalizedSessionIds.has(completedSessionId)) {
    return;
  }
  finalizedSessionIds.add(completedSessionId);

  const blob = new Blob(activeChunks, { type: activeRecorderMimeType });

  if (!shouldDiscardActiveCapture) {
    if (blob.size > 0) {
      sessionSnapshots.set(completedSessionId, {
        blob,
        mimeType: activeRecorderMimeType,
        createdAt: Date.now(),
      });
      if (reason === "flush-timeout") {
        console.warn(
          `[GN Tracing] Recorder never fired stop; salvaged ${activeChunks.length} buffered ` +
            `chunk(s) (${blob.size} bytes). The final second may be missing. ` +
            `tracks=${describeActiveTracks()}`,
        );
      }
    } else {
      emptyRecordingSessions.set(
        completedSessionId,
        activeRecorderError ||
          "The browser produced no video data for this recording. " +
            "If you pressed Stop sharing in the browser before stopping the recording, " +
            "record again and stop from the GN Tracing popup.",
      );
      console.error(
        `[GN Tracing] Recording finished with no data (${reason}). ` +
          `chunks=${activeChunks.length} tracks=${describeActiveTracks()} ` +
          `recorderError=${activeRecorderError ?? "none"}`,
      );
    }
  }

  chrome.runtime.sendMessage({
    action: "RECORDING_COMPLETE",
    data: {
      sessionId: completedSessionId,
      mimeType: activeRecorderMimeType,
      size: blob.size,
    },
  });
}

async function stopCapture(): Promise<void> {
  if (!recorder || recorder.state === "inactive") {
    await stopActiveMediaStream();
    return;
  }

  console.info(
    `[GN Tracing] Stopping recorder: state=${recorder.state} ` +
      `chunks=${activeChunks.length} tracks=${describeActiveTracks()}`,
  );

  // The recorder's own `stop` handler releases the stream once the blob exists.
  const { flushed } = await stopRecorderAndWaitForFlush(
    recorder,
    recorderFlush?.promise ?? Promise.resolve(),
    RECORDER_FLUSH_TIMEOUT_MS,
  );

  if (!flushed) {
    // No stop event. Save the buffered chunks rather than losing the recording,
    // then release the stream ourselves since the stop handler never ran.
    finalizeRecordingSnapshot("flush-timeout");
    clearActiveCapture();
    await stopActiveMediaStream();
  }
}

async function discardCapture(): Promise<void> {
  shouldDiscardActiveCapture = true;
  if (!recorder || recorder.state === "inactive") {
    clearActiveCapture();
    return;
  }
  await stopCapture();
}

function deleteSessionSnapshot(sessionId: string): void {
  if (!sessionId) {
    return;
  }
  sessionSnapshots.delete(sessionId);
  emptyRecordingSessions.delete(sessionId);
  finalizedSessionIds.delete(sessionId);
}

function splitBlobIntoParts(blob: Blob, maxChunkSize: number): Blob[] {
  if (blob.size <= maxChunkSize) {
    return [blob];
  }

  const parts: Blob[] = [];
  let offset = 0;
  while (offset < blob.size) {
    const end = Math.min(offset + maxChunkSize, blob.size);
    parts.push(blob.slice(offset, end, blob.type));
    offset = end;
  }
  return parts;
}

async function createArtifactBlob(
  sessionId: string,
  key: UploadArtifactKey,
  inlineValue: string | undefined,
): Promise<Blob | null> {
  if (inlineValue) {
    return new Blob([inlineValue], { type: "application/json" });
  }

  const chunks: string[] = [];
  let offset = 0;
  let totalLength = 0;

  while (true) {
    const result = (await chrome.runtime.sendMessage({
      action: "GET_UPLOAD_ARTIFACT_CHUNK",
      data: { sessionId, key, offset },
    })) as UploadArtifactChunkResponse;

    if (!result?.ok) {
      throw new Error(result?.error || `Failed to load ${key} artifact.`);
    }

    const chunk = result.chunk || "";
    totalLength = typeof result.totalLength === "number" ? result.totalLength : totalLength;

    if (chunk) {
      chunks.push(chunk);
    }

    offset = typeof result.nextOffset === "number" ? result.nextOffset : offset + chunk.length;
    if (!chunk || offset >= totalLength) {
      break;
    }
  }

  if (chunks.length === 0 && totalLength === 0) {
    return null;
  }

  return new Blob(chunks, { type: "application/json" });
}

function createBlobFromDataUrl(dataUrl: string | null | undefined): Blob | null {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
    return null;
  }

  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1) {
    return null;
  }

  const metadata = dataUrl.slice(5, commaIndex);
  const payload = dataUrl.slice(commaIndex + 1);
  const [mimeType = "application/octet-stream", encoding] = metadata.split(";");
  if (encoding === "base64") {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new Blob([bytes], { type: mimeType });
  }

  return new Blob([decodeURIComponent(payload)], { type: mimeType });
}

export interface ScreenshotUploadData {
  authToken: string;
  storageProvider?: StorageProviderId;
  targetFolderPath?: string[];
  targetFolderId?: string | null;
  zipPassword?: string | null;
  url?: string;
  /**
   * Bulk still + IR/evidence JSON in IndexedDB (extension origin, shared with
   * the service worker). Avoids the 64MiB runtime message cap.
   */
  stagingId?: string;
  /** Screenshots; imageDataUrl may be omitted when stagingId supplies it. */
  screenshots: Array<{ screenshot: Screenshot; imageDataUrl?: string }>;
  /** Inline JSON artifacts for small/legacy packages without stagingId. */
  artifacts?: Partial<Record<string, string>>;
  /**
   * Product path for package capabilities. Screenshot = still only;
   * instant-replay = DOM + console/network claims. Defaults to screenshot.
   */
  packageKind?: "screenshot" | "instant-replay";
}

/**
 * Uploads a screenshot report: annotated images, no video.
 *
 * Deliberately a separate entry point from `uploadRecordingPackage` rather than
 * a flag on it. That function's whole shape — session snapshots, WebM seek
 * repair, byte-split video parts, three-step progress — is about media, and
 * none of it applies here.
 *
 * Production Save path parks bulk bytes in IndexedDB (`stagingId`); this
 * document reads them once and packages without chunked message round-trips.
 */
async function uploadScreenshotPackage(data: ScreenshotUploadData): Promise<{
  ok: boolean;
  recordingUrl?: string;
  folderId?: string;
  indexFileId?: string;
  targetFolderId?: string | null;
  error?: string;
}> {
  const screenshotsIn = Array.isArray(data.screenshots) ? data.screenshots : [];
  const stagingId = typeof data.stagingId === "string" && data.stagingId ? data.stagingId : "";

  let resolvedArtifacts: Partial<Record<string, string>> = {
    ...(data.artifacts ?? {}),
  };
  let stagedImageDataUrl: string | null = null;

  if (stagingId) {
    const staged = await getScreenshotPackageStaging(stagingId);
    if (!staged) {
      return {
        ok: false,
        error: "Screenshot package staging is no longer available.",
      };
    }
    stagedImageDataUrl = staged.imageDataUrl || null;
    resolvedArtifacts = { ...staged.artifacts };
  }

  const hasInstantReplayArtifact =
    typeof resolvedArtifacts.instantReplay === "string" &&
    resolvedArtifacts.instantReplay.length > 0;
  // Instant Replay packages may ship lookback without a raster still when
  // captureVisibleTab is unavailable; require at least one of the two.
  if (screenshotsIn.length === 0 && !hasInstantReplayArtifact) {
    return {
      ok: false,
      error: "No screenshots or Instant Replay to upload.",
    };
  }

  const storageProvider: StorageProviderId =
    data.storageProvider === "dropbox" ? "dropbox" : "google-drive";
  const now = new Date();
  const packagedAt = now.toISOString();
  const zipFilename = `gn-tracing-${packagedAt.replace(/[:.]/g, "-").slice(0, 19)}.zip`;

  try {
    const { makeShareable, resolveFolderPath, uploadFile } = createStorageIo(
      storageProvider,
      data.authToken,
    );
    const targetFolderId = await resolveFolderPath(data.targetFolderPath, data.targetFolderId);

    const screenshots: ScreenshotInput[] = [];
    for (const item of screenshotsIn) {
      const imageDataUrl =
        (typeof item.imageDataUrl === "string" && item.imageDataUrl) || stagedImageDataUrl || "";
      const blob = createBlobFromDataUrl(imageDataUrl);
      if (!blob) {
        return {
          ok: false,
          error: `Screenshot ${item.screenshot.id} has no image data.`,
        };
      }
      screenshots.push({
        screenshot: item.screenshot,
        imageBytes: new Uint8Array(await blob.arrayBuffer()),
        imageMimeType: blob.type || "image/jpeg",
      });
    }

    const encoder = new TextEncoder();
    const artifacts: Partial<Record<AttachableArtifactId, Uint8Array>> = {};
    for (const [key, value] of Object.entries(resolvedArtifacts)) {
      if (typeof value === "string" && value) {
        artifacts[key as AttachableArtifactId] = encoder.encode(value);
      }
    }

    const built = await buildScreenshotPackage({
      screenshots,
      packagedAt,
      zipFilename,
      url: data.url,
      storage: { provider: storageProvider, folderId: targetFolderId },
      artifacts,
      password: typeof data.zipPassword === "string" ? data.zipPassword : "",
      modifiedAt: now,
      packageKind: data.packageKind === "instant-replay" ? "instant-replay" : "screenshot",
    });

    const zipBlob = new Blob(built.chunks as BlobPart[], {
      type: "application/zip",
    });
    const zipFileId = await uploadFile(zipFilename, zipBlob, targetFolderId);
    const shared = await makeShareable(zipFileId);

    return {
      ok: true,
      recordingUrl: buildExternalPlayerUrl(shared.replayId || zipFileId, storageProvider),
      folderId: targetFolderId || undefined,
      indexFileId: shared.replayId || zipFileId,
      targetFolderId,
    };
  } catch (error) {
    console.error(`[${storageProvider} Screenshot Upload] Error:`, error);
    return { ok: false, error: (error as Error).message };
  }
}

interface StorageIo {
  makeShareable: (fileId: string) => Promise<{ replayId: string }>;
  resolveFolderPath: (
    folderPath: string[] | undefined,
    parentFolderId?: string | null,
  ) => Promise<string | null>;
  uploadFile: (
    filename: string,
    blob: Blob,
    parentId: string | null,
    onProgress?: (loaded: number, total: number) => void,
  ) => Promise<string>;
}

/**
 * The provider-specific half of an upload, behind one interface.
 *
 * Extracted when screenshot packages arrived: they need the same folder
 * resolution, upload, and public-share steps as a recording, and a second copy
 * of this switch is a second place for a Dropbox path-vs-id mistake to hide.
 */
function createStorageIo(storageProvider: StorageProviderId, authToken: string): StorageIo {
  if (storageProvider === "dropbox") {
    return {
      makeShareable: async (path: string) => {
        // Canonical Dropbox replay id = shared-link path+rlkey (not file id).
        const shared = await makeDropboxPublicReadable(authToken, path);
        return { replayId: shared.replayId };
      },
      resolveFolderPath: async (folderPath) => resolveDropboxFolderPath(authToken, folderPath),
      uploadFile: async (filename, blob, parentId, onProgress) => {
        const folderPath =
          typeof parentId === "string" && parentId ? parentId.replace(/\/+$/, "") : "";
        const absolutePath = `${folderPath}/${filename}`.replace(/\/+/g, "/");
        const path = absolutePath.startsWith("/") ? absolutePath : `/${absolutePath}`;
        const uploaded = await uploadDropboxFile({
          authToken,
          path,
          blob,
          sessionThresholdBytes: MAX_DROPBOX_SIMPLE_UPLOAD_BYTES,
          onProgress: (p) => onProgress?.(p.loadedBytes, p.totalBytes),
        });
        return uploaded.path;
      },
    };
  }

  return {
    makeShareable: async (fileId: string) => {
      await makeGoogleDrivePublicReadable(authToken, fileId);
      return { replayId: fileId };
    },
    resolveFolderPath: (folderPath, parentFolderId) =>
      resolveGoogleDriveFolderPath(authToken, folderPath, parentFolderId),
    uploadFile: async (filename, blob, parentId, onProgress) =>
      uploadGoogleDriveFile({
        authToken,
        filename,
        blob,
        parentId,
        resumableThresholdBytes: MAX_DRIVE_UPLOAD_BYTES,
        onProgress: (p) => onProgress?.(p.loadedBytes, p.totalBytes),
      }),
  };
}

async function uploadRecordingPackage(data: StorageUploadData): Promise<{
  ok: boolean;
  recordingUrl?: string;
  folderId?: string;
  indexFileId?: string;
  targetFolderId?: string | null;
  error?: string;
}> {
  const sessionId = String(data.sessionId || "");
  if (!sessionId) {
    return { ok: false, error: "Missing session id." };
  }

  const snapshot = sessionSnapshots.get(sessionId);
  if (!snapshot) {
    // A recording that produced no bytes is a different failure from a snapshot
    // that existed and was dropped — say which one happened.
    const emptyReason = emptyRecordingSessions.get(sessionId);
    if (emptyReason) {
      return { ok: false, error: emptyReason };
    }
    return {
      ok: false,
      error: "Recording snapshot is no longer available for upload.",
    };
  }

  const now = new Date();
  const dateStr = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const baseName = `gn-tracing-${dateStr}`;
  // Only providers with I/O implemented here may label metadata/URLs.
  const requestedProvider = data.storageProvider;
  const storageProvider: StorageProviderId =
    requestedProvider === "dropbox" ? "dropbox" : "google-drive";

  try {
    const { makeShareable, resolveFolderPath, uploadFile } = createStorageIo(
      storageProvider,
      data.authToken,
    );

    // MediaRecorder WebM often omits Duration/Cues, so browsers cannot random-seek
    // until the file has been progressively demuxed. Rebuild seek metadata on the
    // full blob before byte-splitting so packaged parts reassemble to a seekable file.
    let packagedVideoBlob = snapshot.blob;
    try {
      const seekFix = await makeWebmSeekable(snapshot.blob, {
        mimeType: snapshot.mimeType,
      });
      if (seekFix.ok) {
        packagedVideoBlob = seekFix.blob;
        if (seekFix.method === "cues") {
          console.info("[GN Tracing] Applied WebM cues seek fix for seekable replay");
        }
      } else {
        console.warn("[GN Tracing] WebM seek fix skipped:", seekFix.reason);
      }
    } catch (error) {
      console.warn("[GN Tracing] WebM seek fix failed; uploading original blob:", error);
    }

    const videoParts = splitBlobIntoParts(packagedVideoBlob, MAX_PACKAGE_PART_BYTES);
    const totalSteps = 3;
    let completedSteps = 0;
    let totalUploadBytes = 0;
    let uploadedBytes = 0;
    let packageStatus: ProgressItemStatus = "queued";
    let lastProgressSentAt = 0;
    let lastProgressPercent = -1;
    const zipFilename = `${baseName}.zip`;

    const buildProgressItems = (): ProgressItemSnapshot[] => {
      const percent =
        totalUploadBytes > 0
          ? clampPercent((Math.min(uploadedBytes, totalUploadBytes) / totalUploadBytes) * 100)
          : 0;
      return [
        {
          key: "recording-zip",
          label: zipFilename,
          status: packageStatus,
          loadedBytes: uploadedBytes,
          totalBytes: totalUploadBytes,
          percent,
        },
      ];
    };

    const emitProgress = (message: string, force = false): void => {
      const percent =
        totalUploadBytes > 0
          ? clampPercent((uploadedBytes / totalUploadBytes) * 100)
          : completedSteps >= totalSteps
            ? 100
            : 0;
      const nowMs = Date.now();

      if (
        !force &&
        nowMs - lastProgressSentAt < UPLOAD_PROGRESS_THROTTLE_MS &&
        Math.abs(percent - lastProgressPercent) < UPLOAD_PROGRESS_MIN_DELTA
      ) {
        return;
      }

      lastProgressSentAt = nowMs;
      lastProgressPercent = percent;

      sendProgress({
        sessionId,
        step: completedSteps,
        total: totalSteps,
        percent,
        uploadedBytes,
        totalBytes: totalUploadBytes,
        message,
        items: buildProgressItems(),
      });
    };

    emitProgress("Preparing upload...");
    const targetFolderId = await resolveFolderPath(data.targetFolderPath, data.targetFolderId);
    completedSteps += 1;

    packageStatus = "uploading";
    emitProgress("Packaging recording...", true);

    const consoleBlob =
      data.artifactKeys?.consoleLogs || data.consoleLogs
        ? await createArtifactBlob(sessionId, "consoleLogs", data.consoleLogs)
        : null;
    const networkBlob =
      data.artifactKeys?.networkRequests || data.networkRequests
        ? await createArtifactBlob(sessionId, "networkRequests", data.networkRequests)
        : null;
    const websocketBlob =
      data.artifactKeys?.webSocketLogs || data.webSocketLogs
        ? await createArtifactBlob(sessionId, "webSocketLogs", data.webSocketLogs)
        : null;
    const reportBlob =
      data.artifactKeys?.report || data.report
        ? await createArtifactBlob(sessionId, "report", data.report)
        : null;
    const userEventsBlob =
      data.artifactKeys?.userEvents || data.userEvents
        ? await createArtifactBlob(sessionId, "userEvents", data.userEvents)
        : null;
    const drawingBlob =
      data.artifactKeys?.drawing || data.drawing
        ? await createArtifactBlob(sessionId, "drawing", data.drawing)
        : null;
    const privacyBlob =
      data.artifactKeys?.privacy || data.privacy
        ? await createArtifactBlob(sessionId, "privacy", data.privacy)
        : null;
    const diagnosticsBlob =
      data.artifactKeys?.diagnostics || data.diagnostics
        ? await createArtifactBlob(sessionId, "diagnostics", data.diagnostics)
        : null;
    const storageBlob =
      data.artifactKeys?.storage || data.storage
        ? await createArtifactBlob(sessionId, "storage", data.storage)
        : null;
    const domBlob =
      data.artifactKeys?.dom || data.dom
        ? await createArtifactBlob(sessionId, "dom", data.dom)
        : null;
    const screenshotBlob = data.artifactKeys?.screenshot
      ? createBlobFromDataUrl(data.screenshotDataUrl)
      : null;

    // The package layout, index documents, and ZIP container all come from
    // `replay-core/write`, which is also what the browser SDK writes with. This
    // document only supplies the bytes and the storage-provider specifics.
    const packagedAt = new Date().toISOString();
    const artifactBlobs: Partial<Record<AttachableArtifactId, Blob | null>> = {
      console: consoleBlob,
      network: networkBlob,
      websocket: websocketBlob,
      report: reportBlob,
      events: userEventsBlob,
      drawing: drawingBlob,
      privacy: privacyBlob,
      diagnostics: diagnosticsBlob,
      storage: storageBlob,
      dom: domBlob,
      screenshot: screenshotBlob,
    };

    const artifactBytes: Partial<Record<AttachableArtifactId, Uint8Array>> = {};
    for (const [id, blob] of Object.entries(artifactBlobs) as Array<
      [AttachableArtifactId, Blob | null]
    >) {
      if (blob) {
        artifactBytes[id] = new Uint8Array(await blob.arrayBuffer());
      }
    }

    const producerVersion = getProductVersionOrDefault();
    const producerCapabilities = getProducerCapabilities();

    const metadataPreview: PackageMetadata = {
      timestamp: packagedAt,
      duration: data.duration,
      url: data.url,
      startTime: data.startTime,
      extension: "gn-tracing",
      version: producerVersion,
      producer: "extension",
      capabilities: producerCapabilities,
      evidenceCoverage: data.evidenceCoverage,
      storage: {
        provider: storageProvider,
        folderId: targetFolderId,
        package: zipFilename,
      },
      video: {
        mimeType: snapshot.mimeType,
        totalBytes: packagedVideoBlob.size,
        partCount: videoParts.length,
      },
    };

    // Built before the package so it can be written ahead of the video parts.
    const agentSummaryBlob = await createAgentSummaryBlob({
      metadata: metadataPreview,
      consoleBlob,
      networkBlob,
      websocketBlob,
      eventsBlob: userEventsBlob,
      privacyBlob,
      reportBlob,
      availableArtifacts: ["metadata", ...Object.keys(artifactBytes)],
      generatedAt: packagedAt,
    });
    if (agentSummaryBlob) {
      artifactBytes.agentSummary = new Uint8Array(await agentSummaryBlob.arrayBuffer());
    }

    const zipPassword = typeof data.zipPassword === "string" ? data.zipPassword : "";
    if (zipPassword) {
      emitProgress("Protecting recording zip...", true);
    }

    const built = await buildRecordingPackage({
      producer: "extension",
      capabilities: producerCapabilities,
      evidenceCoverage: data.evidenceCoverage,
      packagedAt,
      zipFilename,
      version: producerVersion,
      duration: data.duration,
      url: data.url,
      startTime: data.startTime,
      storage: { provider: storageProvider, folderId: targetFolderId },
      video: {
        mimeType: snapshot.mimeType,
        totalBytes: packagedVideoBlob.size,
        parts: await Promise.all(
          videoParts.map(async (part) => ({
            bytes: new Uint8Array(await part.arrayBuffer()),
          })),
        ),
      },
      artifacts: artifactBytes,
      password: zipPassword,
      modifiedAt: now,
    });

    // Kept as a Blob rather than one contiguous buffer: a package is mostly
    // video, and the upload paths stream from a Blob anyway.
    const zipBlob = new Blob(built.chunks as BlobPart[], {
      type: "application/zip",
    });
    totalUploadBytes = zipBlob.size;
    completedSteps += 1;
    uploadedBytes = 0;
    emitProgress("Uploading recording package...", true);

    let zipFileId: string | null = null;
    let replayId: string | null = null;
    try {
      zipFileId = await uploadFile(zipFilename, zipBlob, targetFolderId, (loaded, total) => {
        uploadedBytes = Math.min(loaded, total || zipBlob.size);
        emitProgress("Uploading recording package...");
      });
      // Hard-fail if public share cannot be created (standalone needs anonymous download).
      const shared = await makeShareable(zipFileId);
      replayId = shared.replayId;
    } catch (error) {
      packageStatus = "failed";
      emitProgress("Uploading recording package...", true);
      throw error;
    }

    uploadedBytes = zipBlob.size;
    packageStatus = "uploaded";
    completedSteps += 1;
    emitProgress("Upload complete!", true);

    // Google: /gdrive/<fileId>; Dropbox: /dropbox/<shared-link-id>.
    const recordingUrl = buildExternalPlayerUrl(replayId || zipFileId || "", storageProvider);
    return {
      ok: true,
      recordingUrl,
      folderId: targetFolderId || undefined,
      indexFileId: replayId || zipFileId || undefined,
      targetFolderId,
    };
  } catch (error) {
    console.error(`[${storageProvider} Upload] Error:`, error);
    return { ok: false, error: (error as Error).message };
  }
}
