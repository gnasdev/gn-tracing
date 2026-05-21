/**
 * Runs tab media capture and Google Drive upload work in an offscreen document.
 */
import type { ProgressItemSnapshot, ProgressItemStatus } from "../types/messages";
import { buildExternalPlayerUrl } from "../shared/player-host";

/**
 * Offscreen document runtime for media capture and Google Drive uploads.
 *
 * MV3 service workers cannot own a MediaRecorder or long-lived MediaStream, so
 * this document holds the active tab stream, final recording snapshots, and the
 * upload pipeline. The service worker communicates with it through runtime
 * messages and treats this file as the media/upload worker.
 */
let recorder: MediaRecorder | null = null;
let activeChunks: Blob[] = [];
let activeSessionId: string | null = null;
let activeStream: MediaStream | null = null;
let playbackAudioContext: AudioContext | null = null;
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
  duration: number;
  url: string;
  startTime: number | null;
  sessionId: string;
}

interface GoogleDriveUploadData extends ZipData {
  authToken: string;
  targetFolderId?: string | null;
  targetFolderPath?: string[];
  zipPassword?: string | null;
  artifactKeys?: {
    consoleLogs?: boolean;
    networkRequests?: boolean;
    webSocketLogs?: boolean;
  };
}

type UploadArtifactKey = "consoleLogs" | "networkRequests" | "webSocketLogs";

interface UploadArtifactChunkResponse {
  ok: boolean;
  chunk?: string;
  nextOffset?: number;
  totalLength?: number;
  error?: string;
}

interface DriveFileDescriptor {
  id: string;
  name: string;
  size?: number;
  mimeType?: string;
}

interface RecordingManifest {
  schemaVersion: number;
  folderId: string | null;
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

const MAX_DRIVE_UPLOAD_BYTES = 32 * 1024 * 1024;
const UPLOAD_PROGRESS_THROTTLE_MS = 250;
const UPLOAD_PROGRESS_MIN_DELTA = 0.5;
const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_ENCRYPTION_PAYLOAD_PATH = "encrypted-payload.bin";
const ZIP_ENCRYPTION_ALGORITHM = "AES-GCM";
const ZIP_ENCRYPTION_KDF = "PBKDF2-SHA-256";
const ZIP_ENCRYPTION_ITERATIONS = 250_000;
const ZIP_ENCRYPTION_SALT_BYTES = 16;
const ZIP_ENCRYPTION_IV_BYTES = 12;

// The offscreen document exposes a small command surface to the service worker.
// Keep message names stable with the service-worker caller because there is no
// compile-time link between these runtime message payloads.
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

    case "DISCARD_CAPTURE":
      discardCapture();
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
  shouldDiscardActiveCapture = false;

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

function stopCapture(): void {
  if (recorder && recorder.state !== "inactive") {
    recorder.stop();
  }
}

function discardCapture(): void {
  shouldDiscardActiveCapture = true;
  if (!recorder || recorder.state === "inactive") {
    clearActiveCapture();
    return;
  }
  stopCapture();
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
    const result = await chrome.runtime.sendMessage({
      action: "GET_UPLOAD_ARTIFACT_CHUNK",
      data: { sessionId, key, offset },
    }) as UploadArtifactChunkResponse;

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

function makeCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < table.length; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[i] = value >>> 0;
  }
  return table;
}

const CRC32_TABLE = makeCrc32Table();

function calculateCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUint16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}

function writeUint32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}

function createZipTimestamp(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: dosDate };
}

// Write a dependency-free ZIP package using the store method so the static player
// can unzip recordings without adding a bundled compression library.
async function createZipBlob(entries: Array<{ name: string; blob: Blob }>, modifiedAt = new Date()): Promise<Blob> {
  const encoder = new TextEncoder();
  const chunks: BlobPart[] = [];
  const centralDirectory: ArrayBuffer[] = [];
  const timestamp = createZipTimestamp(modifiedAt);
  let offset = 0;

  for (const entry of entries) {
    const safeName = entry.name.replace(/^\/+/, "");
    if (!safeName || safeName.includes("..")) {
      throw new Error(`Invalid zip entry name: ${entry.name}`);
    }

    const nameBytes = encoder.encode(safeName);
    const bytes = new Uint8Array(await entry.blob.arrayBuffer());
    const crc32 = calculateCrc32(bytes);
    const localHeader = new ArrayBuffer(30 + nameBytes.length);
    const localView = new DataView(localHeader);

    writeUint32(localView, 0, ZIP_LOCAL_FILE_HEADER_SIGNATURE);
    writeUint16(localView, 4, 20);
    writeUint16(localView, 6, 0x0800);
    writeUint16(localView, 8, 0);
    writeUint16(localView, 10, timestamp.time);
    writeUint16(localView, 12, timestamp.date);
    writeUint32(localView, 14, crc32);
    writeUint32(localView, 18, bytes.length);
    writeUint32(localView, 22, bytes.length);
    writeUint16(localView, 26, nameBytes.length);
    writeUint16(localView, 28, 0);
    new Uint8Array(localHeader, 30).set(nameBytes);
    chunks.push(localHeader, bytes);

    const centralHeader = new ArrayBuffer(46 + nameBytes.length);
    const centralView = new DataView(centralHeader);
    writeUint32(centralView, 0, ZIP_CENTRAL_DIRECTORY_SIGNATURE);
    writeUint16(centralView, 4, 20);
    writeUint16(centralView, 6, 20);
    writeUint16(centralView, 8, 0x0800);
    writeUint16(centralView, 10, 0);
    writeUint16(centralView, 12, timestamp.time);
    writeUint16(centralView, 14, timestamp.date);
    writeUint32(centralView, 16, crc32);
    writeUint32(centralView, 20, bytes.length);
    writeUint32(centralView, 24, bytes.length);
    writeUint16(centralView, 28, nameBytes.length);
    writeUint16(centralView, 30, 0);
    writeUint16(centralView, 32, 0);
    writeUint16(centralView, 34, 0);
    writeUint16(centralView, 36, 0);
    writeUint32(centralView, 38, 0);
    writeUint32(centralView, 42, offset);
    new Uint8Array(centralHeader, 46).set(nameBytes);
    centralDirectory.push(centralHeader);

    offset += localHeader.byteLength + bytes.length;
  }

  const centralDirectorySize = centralDirectory.reduce((sum, part) => sum + part.byteLength, 0);
  const endRecord = new ArrayBuffer(22);
  const endView = new DataView(endRecord);
  writeUint32(endView, 0, ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE);
  writeUint16(endView, 4, 0);
  writeUint16(endView, 6, 0);
  writeUint16(endView, 8, entries.length);
  writeUint16(endView, 10, entries.length);
  writeUint32(endView, 12, centralDirectorySize);
  writeUint32(endView, 16, offset);
  writeUint16(endView, 20, 0);

  return new Blob([...chunks, ...centralDirectory, endRecord], { type: "application/zip" });
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function deriveZipPasswordKey(password: string, salt: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Browser crypto is not available for password-protected recordings.");
  }

  const keyMaterial = await globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );

  return globalThis.crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: toArrayBuffer(salt),
      iterations: ZIP_ENCRYPTION_ITERATIONS,
    },
    keyMaterial,
    { name: ZIP_ENCRYPTION_ALGORITHM, length: 256 },
    false,
    usages,
  );
}

async function createEncryptedZipBlob(
  innerZipBlob: Blob,
  password: string,
  zipFilename: string,
  targetFolderId: string | null,
  modifiedAt: Date,
): Promise<Blob> {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(ZIP_ENCRYPTION_SALT_BYTES));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(ZIP_ENCRYPTION_IV_BYTES));
  const key = await deriveZipPasswordKey(password, salt, ["encrypt"]);
  const encryptedPayload = await globalThis.crypto.subtle.encrypt(
    { name: ZIP_ENCRYPTION_ALGORITHM, iv: toArrayBuffer(iv) },
    key,
    await innerZipBlob.arrayBuffer(),
  );
  const clearIndex = {
    schemaVersion: 3,
    folderId: targetFolderId,
    package: {
      filename: zipFilename,
      format: "zip",
      encrypted: true,
    },
    encryption: {
      version: 1,
      algorithm: ZIP_ENCRYPTION_ALGORITHM,
      kdf: ZIP_ENCRYPTION_KDF,
      iterations: ZIP_ENCRYPTION_ITERATIONS,
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      payloadPath: ZIP_ENCRYPTION_PAYLOAD_PATH,
      cleartext: "gn-tracing-recording-zip",
    },
  };

  // The outer ZIP deliberately exposes only unlock metadata; the replay artifacts
  // remain inside the encrypted inner ZIP until the player receives the password.
  return createZipBlob([
    {
      name: "recording-index.json",
      blob: new Blob([JSON.stringify(clearIndex, null, 2)], { type: "application/json" }),
    },
    {
      name: ZIP_ENCRYPTION_PAYLOAD_PATH,
      blob: new Blob([encryptedPayload], { type: "application/octet-stream" }),
    },
  ], modifiedAt);
}

async function uploadToGoogleDrive(
  data: GoogleDriveUploadData,
): Promise<{ ok: boolean; recordingUrl?: string; folderId?: string; indexFileId?: string; targetFolderId?: string | null; error?: string }> {
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
      const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
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

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error?.message || `Share permission failed with status ${response.status}`);
      }
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

    const findFolder = async (folderName: string, parentFolderId?: string | null): Promise<string | null> => {
      const escapedName = folderName.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      const parentQuery = parentFolderId ? `'${parentFolderId}' in parents` : "'root' in parents";
      const query = [
        "mimeType = 'application/vnd.google-apps.folder'",
        "trashed = false",
        `name = '${escapedName}'`,
        parentQuery,
      ].join(" and ");
      const url = new URL("https://www.googleapis.com/drive/v3/files");
      url.searchParams.set("fields", "files(id,name)");
      url.searchParams.set("pageSize", "1");
      url.searchParams.set("q", query);
      url.searchParams.set("supportsAllDrives", "true");
      url.searchParams.set("includeItemsFromAllDrives", "true");

      const response = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${data.authToken}`,
        },
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error?.message || `Find folder failed with status ${response.status}`);
      }

      const result = await response.json().catch(() => ({}));
      const folder = Array.isArray(result.files) ? result.files[0] : null;
      return typeof folder?.id === "string" ? folder.id : null;
    };

    const resolveFolderPath = async (folderPath: string[] | undefined, parentFolderId?: string | null): Promise<string | null> => {
      let currentParentId = parentFolderId || null;
      const safePath = Array.isArray(folderPath)
        ? folderPath.filter((segment) => typeof segment === "string" && segment.trim())
        : [];

      for (const rawSegment of safePath) {
        const segment = rawSegment.trim();
        const existingFolderId = await findFolder(segment, currentParentId);
        currentParentId = existingFolderId || await createFolder(segment, currentParentId);
      }

      return currentParentId;
    };

    const uploadFile = async (
      filename: string,
      blob: Blob,
      parentId: string | null,
      onProgress?: (loaded: number, total: number) => void,
    ): Promise<string> => {
      // A single recording package can be much larger than the old split parts,
      // so large zips use Drive's resumable media upload path.
      if (blob.size > MAX_DRIVE_UPLOAD_BYTES) {
        const sessionResponse = await fetch(
          "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id&supportsAllDrives=true",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${data.authToken}`,
              "Content-Type": "application/json",
              "X-Upload-Content-Type": blob.type || "application/octet-stream",
              "X-Upload-Content-Length": String(blob.size),
            },
            body: JSON.stringify({
              name: filename,
              ...(parentId ? { parents: [parentId] } : {}),
            }),
          },
        );

        if (!sessionResponse.ok) {
          const error = await sessionResponse.json().catch(() => ({}));
          throw new Error(error.error?.message || `Start resumable upload failed with status ${sessionResponse.status}`);
        }

        const uploadUrl = sessionResponse.headers.get("Location");
        if (!uploadUrl) {
          throw new Error("Drive did not return a resumable upload URL");
        }

        const result = await new Promise<{ id: string }>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("PUT", uploadUrl);
          xhr.setRequestHeader("Content-Type", blob.type || "application/octet-stream");
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

          xhr.send(blob);
        });

        onProgress?.(blob.size, blob.size);
        return result.id;
      }

      const formData = new FormData();
      formData.append(
        "metadata",
        new Blob(
          [
            JSON.stringify({
              name: filename,
              ...(parentId ? { parents: [parentId] } : {}),
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
      return result.id;
    };

    const videoParts = splitBlobIntoParts(snapshot.blob, MAX_DRIVE_UPLOAD_BYTES);
    const totalSteps = 3;
    let completedSteps = 0;
    let totalUploadBytes = 0;
    let uploadedBytes = 0;
    let packageStatus: ProgressItemStatus = "queued";
    let lastProgressSentAt = 0;
    let lastProgressPercent = -1;
    const zipFilename = `${baseName}.zip`;

    const buildProgressItems = (): ProgressItemSnapshot[] => {
      const percent = totalUploadBytes > 0
        ? clampPercent((Math.min(uploadedBytes, totalUploadBytes) / totalUploadBytes) * 100)
        : 0;
      return [{
        key: "recording-zip",
        label: zipFilename,
        status: packageStatus,
        loadedBytes: uploadedBytes,
        totalBytes: totalUploadBytes,
        percent,
      }];
    };

    const emitProgress = (message: string, force = false): void => {
      const percent = totalUploadBytes > 0
        ? clampPercent((uploadedBytes / totalUploadBytes) * 100)
        : completedSteps >= totalSteps ? 100 : 0;
      const nowMs = Date.now();

      if (!force && nowMs - lastProgressSentAt < UPLOAD_PROGRESS_THROTTLE_MS && Math.abs(percent - lastProgressPercent) < UPLOAD_PROGRESS_MIN_DELTA) {
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

    const consoleBlob = (data.artifactKeys?.consoleLogs || data.consoleLogs)
      ? await createArtifactBlob(sessionId, "consoleLogs", data.consoleLogs)
      : null;
    const networkBlob = (data.artifactKeys?.networkRequests || data.networkRequests)
      ? await createArtifactBlob(sessionId, "networkRequests", data.networkRequests)
      : null;
    const websocketBlob = (data.artifactKeys?.webSocketLogs || data.webSocketLogs)
      ? await createArtifactBlob(sessionId, "webSocketLogs", data.webSocketLogs)
      : null;

    const artifacts: RecordingManifest["artifacts"] = {
      metadata: "metadata.json",
      ...(consoleBlob ? { console: "console.json" } : {}),
      ...(networkBlob ? { network: "network.json" } : {}),
      ...(websocketBlob ? { websocket: "websocket.json" } : {}),
    };
    const videoDescriptors: DriveFileDescriptor[] = videoParts.map((part, index) => ({
      id: `video.part-${String(index).padStart(3, "0")}.webm`,
      name: `video.part-${String(index).padStart(3, "0")}.webm`,
      size: part.size,
      mimeType: snapshot.mimeType,
    }));
    const metadataBlob = new Blob(
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
              folderId: targetFolderId,
              package: zipFilename,
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
    const manifest: RecordingManifest = {
      schemaVersion: 1,
      folderId: targetFolderId,
      video: {
        mimeType: snapshot.mimeType,
        totalBytes: snapshot.blob.size,
        parts: videoDescriptors.map((part) => ({
          name: part.name,
          size: part.size || 0,
        })),
      },
      artifacts,
    };
    const manifestBlob = new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" });
    const recordingIndex = {
      schemaVersion: 2,
      folderId: targetFolderId,
      package: {
        filename: zipFilename,
        format: "zip",
      },
      manifestPath: "manifest.json",
      metadataPath: "metadata.json",
      artifacts: {
        ...(consoleBlob ? { consolePath: "console.json" } : {}),
        ...(networkBlob ? { networkPath: "network.json" } : {}),
        ...(websocketBlob ? { websocketPath: "websocket.json" } : {}),
      },
      video: {
        mimeType: snapshot.mimeType,
        totalBytes: snapshot.blob.size,
        partPaths: videoDescriptors.map((part) => part.name),
      },
    };
    const indexBlob = new Blob([JSON.stringify(recordingIndex, null, 2)], { type: "application/json" });
    const zipEntries: Array<{ name: string; blob: Blob }> = [
      { name: "recording-index.json", blob: indexBlob },
      { name: "manifest.json", blob: manifestBlob },
      { name: "metadata.json", blob: metadataBlob },
      ...videoParts.map((blob, index) => ({
        name: `video.part-${String(index).padStart(3, "0")}.webm`,
        blob,
      })),
    ];

    if (consoleBlob) {
      zipEntries.push({ name: "console.json", blob: consoleBlob });
    }
    if (networkBlob) {
      zipEntries.push({ name: "network.json", blob: networkBlob });
    }
    if (websocketBlob) {
      zipEntries.push({ name: "websocket.json", blob: websocketBlob });
    }

    const zipPassword = typeof data.zipPassword === "string" ? data.zipPassword : "";
    const innerZipBlob = await createZipBlob(zipEntries, now);
    if (zipPassword) {
      emitProgress("Encrypting recording package...", true);
    }
    const zipBlob = zipPassword
      ? await createEncryptedZipBlob(innerZipBlob, zipPassword, zipFilename, targetFolderId, now)
      : innerZipBlob;
    totalUploadBytes = zipBlob.size;
    completedSteps += 1;
    uploadedBytes = 0;
    emitProgress("Uploading recording package...", true);

    let zipFileId: string | null = null;
    try {
      zipFileId = await uploadFile(zipFilename, zipBlob, targetFolderId, (loaded, total) => {
        uploadedBytes = Math.min(loaded, total || zipBlob.size);
        emitProgress("Uploading recording package...");
      });
      await makeShareable(zipFileId);
    } catch (error) {
      packageStatus = "failed";
      emitProgress("Uploading recording package...", true);
      throw error;
    }

    uploadedBytes = zipBlob.size;
    packageStatus = "uploaded";
    completedSteps += 1;
    emitProgress("Upload complete!", true);

    const recordingUrl = buildExternalPlayerUrl(zipFileId || "");
    return { ok: true, recordingUrl, folderId: targetFolderId || undefined, indexFileId: zipFileId || undefined, targetFolderId };
  } catch (error) {
    console.error("[Google Drive Upload] Error:", error);
    return { ok: false, error: (error as Error).message };
  }
}
