import type { ProgressItemSnapshot, ProgressItemStatus } from "../types/messages";
import { buildExternalPlayerUrl } from "../shared/player-host";

let recorder: MediaRecorder | null = null;
let activeChunks: Blob[] = [];
let activeSessionId: string | null = null;
let activeStream: MediaStream | null = null;
let playbackAudioContext: AudioContext | null = null;
let isCapturePaused = false;

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
  duration: number;
  url: string;
  startTime: number | null;
  sessionId: string;
}

interface GoogleDriveUploadData extends ZipData {
  authToken: string;
  targetFolderId?: string | null;
}

interface DriveFileDescriptor {
  id: string;
  name: string;
  size?: number;
  mimeType?: string;
}

interface RecordingManifest {
  schemaVersion: number;
  folderId: string;
  video: {
    mimeType: string;
    totalBytes: number;
    parts: Array<{
      name: string;
      size: number;
    }>;
  };
  artifacts: {
    metadata: string;
    console?: string;
    network?: string;
    websocket?: string;
  };
}

interface RecordingIndex {
  schemaVersion: number;
  folderId: string;
  manifestFileId: string;
  metadataFileId: string;
  artifacts: {
    consoleFileId?: string;
    networkFileId?: string;
    websocketFileId?: string;
  };
  video: {
    mimeType: string;
    totalBytes: number;
    partFileIds: string[];
  };
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

interface UploadQueueItem {
  key: string;
  kind: "video" | "console" | "network" | "websocket" | "metadata";
  label: string;
  filename: string;
  blob: Blob;
  required: boolean;
  index?: number;
}

const MAX_DRIVE_UPLOAD_BYTES = 32 * 1024 * 1024;

chrome.runtime.onMessage.addListener((message: OffscreenIncomingMessage, _sender, sendResponse) => {
  if (message.target !== "offscreen") {
    return false;
  }

  switch (message.type) {
    case "START_CAPTURE":
      startCapture(
        String(message.data?.streamId || ""),
        String(message.data?.sessionId || ""),
      )
        .then(() => sendResponse({ ok: true }))
        .catch((error: Error) => sendResponse({ ok: false, error: error.message }));
      return true;

    case "STOP_CAPTURE":
      stopCapture();
      sendResponse({ ok: true });
      return false;

    case "PAUSE_CAPTURE":
      pauseCapture();
      sendResponse({ ok: true });
      return false;

    case "RESUME_CAPTURE":
      resumeCapture();
      sendResponse({ ok: true });
      return false;

    case "DELETE_SESSION_SNAPSHOT":
      deleteSessionSnapshot(String(message.data?.sessionId || ""));
      sendResponse({ ok: true });
      return false;

    case "GET_CAPTURE_STATE":
      sendResponse({
        ok: true,
        isRecording: Boolean(recorder && recorder.state !== "inactive"),
        isPaused: isCapturePaused,
        activeSessionId,
        snapshotSessionIds: Array.from(sessionSnapshots.keys()),
      });
      return false;

    case "UPLOAD_TO_GOOGLE_DRIVE":
      uploadToGoogleDrive(message.data as unknown as GoogleDriveUploadData)
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

function clearActiveCapture(): void {
  activeChunks = [];
  activeSessionId = null;
  isCapturePaused = false;

  if (recorder) {
    recorder.ondataavailable = null;
    recorder.onstop = null;
    recorder = null;
  }

  if (activeStream) {
    activeStream.getTracks().forEach((track) => track.stop());
    activeStream = null;
  }

  if (playbackAudioContext) {
    void playbackAudioContext.close().catch(() => {});
    playbackAudioContext = null;
  }
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
  source.connect(playbackAudioContext.destination);

  const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
    ? "video/webm;codecs=vp9,opus"
    : "video/webm;codecs=vp8,opus";
  const finalMimeType = mimeType;

  recorder = new MediaRecorder(stream, { mimeType });
  activeStream = stream;
  activeSessionId = sessionId;
  activeChunks = [];
  isCapturePaused = false;

  recorder.ondataavailable = (event: BlobEvent) => {
    if (event.data.size > 0) {
      activeChunks.push(event.data);
    }
  };

  recorder.onstop = () => {
    const completedSessionId = activeSessionId;
    const blob = new Blob(activeChunks, { type: finalMimeType });

    if (completedSessionId && blob.size > 0) {
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

function stopCapture(): void {
  if (recorder && recorder.state !== "inactive") {
    recorder.stop();
  }
}

function pauseCapture(): void {
  if (recorder && recorder.state === "recording") {
    recorder.pause();
    isCapturePaused = true;
  }
}

function resumeCapture(): void {
  if (recorder && recorder.state === "paused") {
    recorder.resume();
    isCapturePaused = false;
  }
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

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const runWorker = async (): Promise<void> => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= items.length) {
        return;
      }

      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, () => runWorker()),
  );

  return results;
}

async function uploadToGoogleDrive(
  data: GoogleDriveUploadData,
): Promise<{ ok: boolean; recordingUrl?: string; folderId?: string; indexFileId?: string; error?: string }> {
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

  try {
    const makeShareable = async (fileId: string): Promise<void> => {
      await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${data.authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "anyone",
          role: "reader",
        }),
      });
    };

    const createFolder = async (folderName: string, parentFolderId?: string | null): Promise<string> => {
      const response = await fetch(
        "https://www.googleapis.com/drive/v3/files?fields=id&supportsAllDrives=true",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${data.authToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: folderName,
            mimeType: "application/vnd.google-apps.folder",
            ...(parentFolderId ? { parents: [parentFolderId] } : {}),
          }),
        },
      );

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error?.message || `Create folder failed with status ${response.status}`);
      }

      const result = await response.json();
      await makeShareable(result.id);
      return result.id;
    };

    const uploadFile = async (
      filename: string,
      blob: Blob,
      parentId: string,
      onProgress?: (loaded: number, total: number) => void,
    ): Promise<string> => {
      const formData = new FormData();
      formData.append(
        "metadata",
        new Blob(
          [
            JSON.stringify({
              name: filename,
              parents: [parentId],
            }),
          ],
          { type: "application/json" },
        ),
      );
      formData.append("file", blob, filename);

      const result = await new Promise<{ id: string }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open(
          "POST",
          "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id&supportsAllDrives=true",
        );
        xhr.setRequestHeader("Authorization", `Bearer ${data.authToken}`);

        xhr.upload.addEventListener("progress", (event) => {
          const loaded = event.lengthComputable && event.total > 0
            ? Math.min(blob.size, Math.round((event.loaded / event.total) * blob.size))
            : Math.min(event.loaded, blob.size);
          onProgress?.(loaded, blob.size);
        });

        xhr.onerror = () => reject(new Error("Upload failed due to a network error"));
        xhr.onload = () => {
          let payload: { id?: string; error?: { message?: string } } = {};
          try {
            payload = xhr.responseText ? JSON.parse(xhr.responseText) : {};
          } catch {
            payload = {};
          }

          if (xhr.status < 200 || xhr.status >= 300 || !payload.id) {
            reject(new Error(payload.error?.message || `Upload failed with status ${xhr.status}`));
            return;
          }

          resolve({ id: payload.id });
        };

        xhr.send(formData);
      });

      onProgress?.(blob.size, blob.size);
      await makeShareable(result.id);
      return result.id;
    };

    const videoParts = splitBlobIntoParts(snapshot.blob, MAX_DRIVE_UPLOAD_BYTES);
    const uploadItems: UploadQueueItem[] = [];

    videoParts.forEach((part, index) => {
      uploadItems.push({
        key: `video:${index}`,
        kind: "video",
        label: `video.part-${String(index).padStart(3, "0")}.webm`,
        filename: `video.part-${String(index).padStart(3, "0")}.webm`,
        blob: part,
        required: true,
        index,
      });
    });

    if (data.consoleLogs) {
      uploadItems.push({
        key: "console",
        kind: "console",
        label: "console.json",
        filename: "console.json",
        blob: new Blob([data.consoleLogs], { type: "application/json" }),
        required: false,
      });
    }

    if (data.networkRequests) {
      uploadItems.push({
        key: "network",
        kind: "network",
        label: "network.json",
        filename: "network.json",
        blob: new Blob([data.networkRequests], { type: "application/json" }),
        required: false,
      });
    }

    if (data.webSocketLogs) {
      uploadItems.push({
        key: "websocket",
        kind: "websocket",
        label: "websocket.json",
        filename: "websocket.json",
        blob: new Blob([data.webSocketLogs], { type: "application/json" }),
        required: false,
      });
    }

    uploadItems.push({
      key: "metadata",
      kind: "metadata",
      label: "metadata.json",
      filename: "metadata.json",
      blob: new Blob([], { type: "application/json" }),
      required: true,
    });

    let totalUploadBytes = uploadItems.reduce((sum, item) => sum + item.blob.size, 0);
    const totalSteps = 1 + uploadItems.length + 2;
    let completedSteps = 0;
    const uploadedBytesByKey = new Map<string, number>();
    const totalBytesByKey = new Map<string, number>();
    const progressStatusByKey = new Map<string, ProgressItemStatus>();

    for (const item of uploadItems) {
      totalBytesByKey.set(item.key, item.blob.size);
      progressStatusByKey.set(item.key, "queued");
    }
    totalBytesByKey.set("manifest", 0);
    progressStatusByKey.set("manifest", "queued");
    totalBytesByKey.set("index", 0);
    progressStatusByKey.set("index", "queued");

    const buildProgressItems = (): ProgressItemSnapshot[] => {
      const snapshots = uploadItems.map((item) => {
        const totalBytes = Math.max(0, totalBytesByKey.get(item.key) || item.blob.size);
        const loadedBytes = Math.max(0, uploadedBytesByKey.get(item.key) || 0);
        return {
          key: item.key,
          label: item.label,
          status: progressStatusByKey.get(item.key) || "queued",
          loadedBytes,
          totalBytes,
          percent: totalBytes > 0 ? clampPercent((Math.min(loadedBytes, totalBytes) / totalBytes) * 100) : 0,
        };
      });

      for (const staticItem of [
        { key: "manifest", label: "manifest.json" },
        { key: "index", label: "recording-index.json" },
      ]) {
        const totalBytes = Math.max(0, totalBytesByKey.get(staticItem.key) || 0);
        const loadedBytes = Math.max(0, uploadedBytesByKey.get(staticItem.key) || 0);
        snapshots.push({
          key: staticItem.key,
          label: staticItem.label,
          status: progressStatusByKey.get(staticItem.key) || "queued",
          loadedBytes,
          totalBytes,
          percent: totalBytes > 0 ? clampPercent((Math.min(loadedBytes, totalBytes) / totalBytes) * 100) : 0,
        });
      }

      return snapshots;
    };

    const emitProgress = (message: string): void => {
      const uploadedBytes = Array.from(uploadedBytesByKey.values()).reduce((sum, value) => sum + value, 0);
      const percent = totalUploadBytes > 0
        ? clampPercent((uploadedBytes / totalUploadBytes) * 100)
        : completedSteps >= totalSteps ? 100 : 0;

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
    const folderId = await createFolder(baseName, data.targetFolderId);

    const metadataItem = uploadItems.find((item) => item.kind === "metadata");
    if (metadataItem) {
      metadataItem.blob = new Blob(
        [
          JSON.stringify(
            {
              timestamp: new Date().toISOString(),
              duration: data.duration,
              url: data.url,
              startTime: data.startTime,
              extension: "gn-tracing",
              version: "1.0.0",
              storage: {
                provider: "google-drive",
                folderId,
              },
              video: {
                mimeType: snapshot.mimeType,
                totalBytes: snapshot.blob.size,
                partCount: videoParts.length,
              },
            },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      );
      totalUploadBytes = uploadItems.reduce((sum, item) => sum + item.blob.size, 0);
      totalBytesByKey.set("metadata", metadataItem.blob.size);
    }

    completedSteps += 1;
    emitProgress("Uploading recording...");

    const uploadedVideoParts: DriveFileDescriptor[] = [];
    const artifacts: RecordingManifest["artifacts"] = {
      metadata: "metadata.json",
    };
    let consoleFileId: string | null = null;
    let networkFileId: string | null = null;
    let websocketFileId: string | null = null;
    let metadataFileId: string | null = null;

    await mapWithConcurrency(uploadItems, 3, async (item) => {
      progressStatusByKey.set(item.key, "uploading");
      emitProgress("Uploading recording...");

      try {
        const fileId = await uploadFile(item.filename, item.blob, folderId, (loaded, total) => {
          uploadedBytesByKey.set(item.key, Math.min(loaded, total || item.blob.size));
          emitProgress("Uploading recording...");
        });

        uploadedBytesByKey.set(item.key, item.blob.size);
        progressStatusByKey.set(item.key, "uploaded");
        completedSteps += 1;
        emitProgress("Uploading recording...");

        switch (item.kind) {
          case "video":
            uploadedVideoParts[item.index || 0] = {
              id: fileId,
              name: item.filename,
              size: item.blob.size,
              mimeType: snapshot.mimeType,
            };
            break;
          case "console":
            consoleFileId = fileId;
            artifacts.console = item.filename;
            break;
          case "network":
            networkFileId = fileId;
            artifacts.network = item.filename;
            break;
          case "websocket":
            websocketFileId = fileId;
            artifacts.websocket = item.filename;
            break;
          case "metadata":
            metadataFileId = fileId;
            break;
        }
      } catch (error) {
        completedSteps += 1;

        if (item.required) {
          progressStatusByKey.set(item.key, "failed");
          emitProgress("Uploading recording...");
          throw error;
        }

        const alreadyLoaded = Math.max(0, uploadedBytesByKey.get(item.key) || 0);
        const remainingBytes = Math.max(0, item.blob.size - alreadyLoaded);
        uploadedBytesByKey.set(item.key, alreadyLoaded);
        totalUploadBytes = Math.max(0, totalUploadBytes - remainingBytes);
        totalBytesByKey.set(item.key, alreadyLoaded);
        progressStatusByKey.set(item.key, "skipped");
        emitProgress("Uploading recording...");
        console.warn(`[Google Drive Upload] Skipped optional ${item.filename}:`, error);
      }
    });

    if (!metadataFileId) {
      throw new Error("Metadata upload did not return a file ID");
    }

    const manifest: RecordingManifest = {
      schemaVersion: 1,
      folderId,
      video: {
        mimeType: snapshot.mimeType,
        totalBytes: snapshot.blob.size,
        parts: uploadedVideoParts.map((part) => ({
          name: part.name,
          size: part.size || 0,
        })),
      },
      artifacts,
    };

    const manifestBlob = new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" });
    totalUploadBytes += manifestBlob.size;
    totalBytesByKey.set("manifest", manifestBlob.size);
    progressStatusByKey.set("manifest", "uploading");
    emitProgress("Uploading recording...");

    let manifestFileId: string | null = null;
    try {
      manifestFileId = await uploadFile("manifest.json", manifestBlob, folderId, (loaded, total) => {
        uploadedBytesByKey.set("manifest", Math.min(loaded, total || manifestBlob.size));
        emitProgress("Uploading recording...");
      });
    } catch (error) {
      progressStatusByKey.set("manifest", "failed");
      emitProgress("Uploading recording...");
      throw error;
    }

    uploadedBytesByKey.set("manifest", manifestBlob.size);
    progressStatusByKey.set("manifest", "uploaded");
    completedSteps += 1;

    const recordingIndex: RecordingIndex = {
      schemaVersion: 1,
      folderId,
      manifestFileId: manifestFileId || "",
      metadataFileId,
      artifacts: {
        ...(consoleFileId ? { consoleFileId } : {}),
        ...(networkFileId ? { networkFileId } : {}),
        ...(websocketFileId ? { websocketFileId } : {}),
      },
      video: {
        mimeType: snapshot.mimeType,
        totalBytes: snapshot.blob.size,
        partFileIds: uploadedVideoParts.map((part) => part.id),
      },
    };

    const indexBlob = new Blob([JSON.stringify(recordingIndex, null, 2)], { type: "application/json" });
    totalUploadBytes += indexBlob.size;
    totalBytesByKey.set("index", indexBlob.size);
    progressStatusByKey.set("index", "uploading");
    emitProgress("Uploading recording index...");

    let indexFileId: string | null = null;
    try {
      indexFileId = await uploadFile("recording-index.json", indexBlob, folderId, (loaded, total) => {
        uploadedBytesByKey.set("index", Math.min(loaded, total || indexBlob.size));
        emitProgress("Uploading recording index...");
      });
    } catch (error) {
      progressStatusByKey.set("index", "failed");
      emitProgress("Uploading recording index...");
      throw error;
    }

    uploadedBytesByKey.set("index", indexBlob.size);
    progressStatusByKey.set("index", "uploaded");
    completedSteps += 1;
    emitProgress("Upload complete!");

    const recordingUrl = buildExternalPlayerUrl(indexFileId || "");
    return { ok: true, recordingUrl, folderId, indexFileId: indexFileId || undefined };
  } catch (error) {
    console.error("[Google Drive Upload] Error:", error);
    return { ok: false, error: (error as Error).message };
  }
}
