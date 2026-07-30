/**
 * Runs tab media capture and cloud storage upload work in an offscreen document.
 */

import type { Screenshot } from "../../packages/replay-core/src/schema/annotation";
import {
  EXTENSION_CAPABILITIES,
  type PackageMetadata,
} from "../../packages/replay-core/src/schema/package";
import {
  type AttachableArtifactId,
  buildRecordingPackage,
} from "../../packages/replay-core/src/write";
import { getScreenshotPackageStaging } from "../background/screenshot-package-staging-idb";
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
let playbackAudioContext: AudioContext | null = null;
let playbackSourceNode: MediaStreamAudioSourceNode | null = null;
let shouldDiscardActiveCapture = false;

interface SessionRecordingSnapshot {
  blob: Blob;
  mimeType: string;
  createdAt: number;
}

const sessionSnapshots = new Map<string, SessionRecordingSnapshot>();

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

// The offscreen document exposes a small command surface to the service worker.
// Keep message names stable with the service-worker caller because there is no
// compile-time link between these runtime message payloads.
chrome.runtime.onMessage.addListener((message: OffscreenIncomingMessage, _sender, sendResponse) => {
  if (message.target !== "offscreen") {
    return false;
  }

  switch (message.type) {
    case "START_CAPTURE":
      startCapture(String(message.data?.streamId || ""), String(message.data?.sessionId || ""))
        .then(() => sendResponse({ ok: true }))
        .catch((error: Error) => sendResponse({ ok: false, error: error.message }));
      return true;

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

async function startCapture(streamId: string, sessionId: string): Promise<void> {
  if (!streamId || !sessionId) {
    throw new Error("Missing capture session metadata.");
  }

  if (recorder && recorder.state !== "inactive") {
    throw new Error("A recording is already active.");
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    } as MediaTrackConstraints,
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
        maxWidth: 1920,
        maxHeight: 1080,
        maxFrameRate: 30,
      },
    } as MediaTrackConstraints,
  });

  playbackAudioContext = new AudioContext();
  const source = playbackAudioContext.createMediaStreamSource(stream);
  playbackSourceNode = source;
  source.connect(playbackAudioContext.destination);

  const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
    ? "video/webm;codecs=vp9,opus"
    : "video/webm;codecs=vp8,opus";
  const finalMimeType = mimeType;

  recorder = new MediaRecorder(stream, { mimeType });
  activeStream = stream;
  activeSessionId = sessionId;
  activeChunks = [];
  shouldDiscardActiveCapture = false;

  recorder.ondataavailable = (event: BlobEvent) => {
    if (event.data.size > 0) {
      activeChunks.push(event.data);
    }
  };

  recorder.onstop = () => {
    const completedSessionId = activeSessionId;
    const blob = new Blob(activeChunks, { type: finalMimeType });

    if (!shouldDiscardActiveCapture && completedSessionId && blob.size > 0) {
      sessionSnapshots.set(completedSessionId, {
        blob,
        mimeType: finalMimeType,
        createdAt: Date.now(),
      });
    }

    chrome.runtime.sendMessage({
      action: "RECORDING_COMPLETE",
      data: {
        sessionId: completedSessionId,
        mimeType: finalMimeType,
        size: blob.size,
      },
    });

    clearActiveCapture();
  };

  recorder.start();
}

async function stopCapture(): Promise<void> {
  if (!recorder || recorder.state === "inactive") {
    await stopActiveMediaStream();
    return;
  }

  try {
    recorder.requestData();
    recorder.stop();
  } finally {
    // MediaRecorder finalization is asynchronous; release every stream/audio
    // reference now so Chrome clears the capture indicator before upload work starts.
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

  let resolvedArtifacts: Partial<Record<string, string>> = { ...(data.artifacts ?? {}) };
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
    return { ok: false, error: "No screenshots or Instant Replay to upload." };
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
        return { ok: false, error: `Screenshot ${item.screenshot.id} has no image data.` };
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
    });

    const zipBlob = new Blob(built.chunks as BlobPart[], { type: "application/zip" });
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
    return { ok: false, error: "Recording snapshot is no longer available for upload." };
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

    const metadataPreview: PackageMetadata = {
      timestamp: packagedAt,
      duration: data.duration,
      url: data.url,
      startTime: data.startTime,
      extension: "gn-tracing",
      version: "1.0.0",
      producer: "extension",
      capabilities: EXTENSION_CAPABILITIES,
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
      capabilities: EXTENSION_CAPABILITIES,
      packagedAt,
      zipFilename,
      duration: data.duration,
      url: data.url,
      startTime: data.startTime,
      storage: { provider: storageProvider, folderId: targetFolderId },
      video: {
        mimeType: snapshot.mimeType,
        totalBytes: packagedVideoBlob.size,
        parts: await Promise.all(
          videoParts.map(async (part) => ({ bytes: new Uint8Array(await part.arrayBuffer()) })),
        ),
      },
      artifacts: artifactBytes,
      password: zipPassword,
      modifiedAt: now,
    });

    // Kept as a Blob rather than one contiguous buffer: a package is mostly
    // video, and the upload paths stream from a Blob anyway.
    const zipBlob = new Blob(built.chunks as BlobPart[], { type: "application/zip" });
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
