import { buildExternalPlayerUrl } from "../shared/player-host";

let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let recordedBlob: Blob | null = null;
let playbackAudioContext: AudioContext | null = null;

interface OffscreenIncomingMessage {
  target: string;
  type: string;
  data?: Record<string, unknown>;
}

chrome.runtime.onMessage.addListener(
  (message: OffscreenIncomingMessage, _sender, sendResponse) => {
    if (message.target !== "offscreen") return false;

    switch (message.type) {
      case "START_CAPTURE":
        startCapture((message.data as { streamId: string }).streamId)
          .then(() => sendResponse({ ok: true }))
          .catch((e: Error) => sendResponse({ ok: false, error: e.message }));
        return true;

      case "STOP_CAPTURE":
        stopCapture();
        sendResponse({ ok: true });
        return false;

      case "UPLOAD_TO_GOOGLE_DRIVE":
        uploadToGoogleDrive(message.data as unknown as GoogleDriveUploadData)
          .then((result) => sendResponse(result))
          .catch((e: Error) => sendResponse({ ok: false, error: e.message }));
        return true;
    }
  },
);

interface ZipData {
  consoleLogs?: string;
  networkRequests?: string;
  webSocketLogs?: string;
  duration: number;
  url: string;
  startTime: number | null;
}

interface GoogleDriveUploadData extends ZipData {
  authToken: string;
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

const MAX_DRIVE_UPLOAD_BYTES = 32 * 1024 * 1024;

function sendProgress(step: number, total: number, message: string): void {
  chrome.runtime.sendMessage({
    target: "offscreen",
    type: "UPLOAD_PROGRESS",
    data: { step, total, message },
  });
}

function clearCapturedMedia(options?: { clearBlob?: boolean }): void {
  chunks = [];

  if (options?.clearBlob) {
    recordedBlob = null;
  }

  if (recorder) {
    recorder.ondataavailable = null;
    recorder.onstop = null;
    recorder = null;
  }
}

async function startCapture(streamId: string): Promise<void> {
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

  // Pass audio through so the user can still hear the tab
  playbackAudioContext = new AudioContext();
  const source = playbackAudioContext.createMediaStreamSource(stream);
  source.connect(playbackAudioContext.destination);

  const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
    ? "video/webm;codecs=vp9,opus"
    : "video/webm;codecs=vp8,opus";
  const finalMimeType = mimeType;

  recorder = new MediaRecorder(stream, { mimeType });
  chunks = [];
  recordedBlob = null;

  recorder.ondataavailable = (e: BlobEvent) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  recorder.onstop = () => {
    recordedBlob = new Blob(chunks, { type: finalMimeType });
    chunks = [];

    stream.getTracks().forEach((t) => t.stop());
    if (playbackAudioContext) {
      void playbackAudioContext.close().catch(() => {});
      playbackAudioContext = null;
    }

    chrome.runtime.sendMessage({
      action: "RECORDING_COMPLETE",
      data: { mimeType: finalMimeType, size: recordedBlob!.size },
    });

    clearCapturedMedia();
  };

  recorder.start();
}

function stopCapture(): void {
  if (recorder && recorder.state !== "inactive") {
    recorder.stop();
  }
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

async function uploadToGoogleDrive(
  data: GoogleDriveUploadData,
): Promise<{ ok: boolean; recordingUrl?: string; error?: string }> {
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

    const createFolder = async (folderName: string): Promise<string> => {
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

      const response = await fetch(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id&supportsAllDrives=true",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${data.authToken}`,
          },
          body: formData,
        },
      );

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error?.message || `Upload failed with status ${response.status}`);
      }

      const result = await response.json();
      await makeShareable(result.id);
      return result.id;
    };

    const videoMimeType = recordedBlob?.type || "video/webm";
    const videoParts = recordedBlob ? splitBlobIntoParts(recordedBlob, MAX_DRIVE_UPLOAD_BYTES) : [];
    const requiredSteps = 1 + videoParts.length + 2;
    const optionalSteps =
      (data.consoleLogs ? 1 : 0) +
      (data.networkRequests ? 1 : 0) +
      (data.webSocketLogs ? 1 : 0);
    const totalSteps = requiredSteps + optionalSteps;
    let currentStep = 1;

    sendProgress(currentStep, totalSteps, "Creating recording folder...");
    const folderId = await createFolder(baseName);

    const uploadedVideoParts: DriveFileDescriptor[] = [];
    if (recordedBlob) {
      for (const [index, part] of videoParts.entries()) {
        currentStep += 1;
        sendProgress(
          currentStep,
          totalSteps,
          `Uploading video part ${index + 1}/${videoParts.length}...`,
        );
        const filename = `video.part-${String(index).padStart(3, "0")}.webm`;
        const fileId = await uploadFile(filename, part, folderId);
        uploadedVideoParts.push({
          id: fileId,
          name: filename,
          size: part.size,
          mimeType: videoMimeType,
        });
      }
    }

    const artifacts: RecordingManifest["artifacts"] = {
      metadata: "metadata.json",
    };
    let consoleFileId: string | null = null;
    if (data.consoleLogs) {
      currentStep += 1;
      sendProgress(currentStep, totalSteps, "Uploading console logs...");
      try {
        consoleFileId = await uploadFile(
          "console.json",
          new Blob([data.consoleLogs], { type: "application/json" }),
          folderId,
        );
        artifacts.console = "console.json";
      } catch (error) {
        console.warn("[Google Drive Upload] Skipped console logs:", error);
      }
    }

    let networkFileId: string | null = null;
    if (data.networkRequests) {
      currentStep += 1;
      sendProgress(currentStep, totalSteps, "Uploading network logs...");
      try {
        networkFileId = await uploadFile(
          "network.json",
          new Blob([data.networkRequests], { type: "application/json" }),
          folderId,
        );
        artifacts.network = "network.json";
      } catch (error) {
        console.warn("[Google Drive Upload] Skipped network logs:", error);
      }
    }

    let websocketFileId: string | null = null;
    if (data.webSocketLogs) {
      currentStep += 1;
      sendProgress(currentStep, totalSteps, "Uploading websocket logs...");
      try {
        websocketFileId = await uploadFile(
          "websocket.json",
          new Blob([data.webSocketLogs], { type: "application/json" }),
          folderId,
        );
        artifacts.websocket = "websocket.json";
      } catch (error) {
        console.warn("[Google Drive Upload] Skipped websocket logs:", error);
      }
    }

    const manifest: RecordingManifest = {
      schemaVersion: 1,
      folderId,
      video: {
        mimeType: videoMimeType,
        totalBytes: recordedBlob?.size || 0,
        parts: uploadedVideoParts.map((part) => ({
          name: part.name,
          size: part.size || 0,
        })),
      },
      artifacts,
    };

    const metadata = {
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
        mimeType: videoMimeType,
        totalBytes: recordedBlob?.size || 0,
        partCount: uploadedVideoParts.length,
      },
    };

    currentStep += 1;
    sendProgress(currentStep, totalSteps, "Uploading metadata...");
    const metadataFileId = await uploadFile(
      "metadata.json",
      new Blob([JSON.stringify(metadata, null, 2)], { type: "application/json" }),
      folderId,
    );

    currentStep += 1;
    sendProgress(currentStep, totalSteps, "Uploading manifest...");
    await uploadFile(
      "manifest.json",
      new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" }),
      folderId,
    );

    const params = new URLSearchParams();
    if (uploadedVideoParts.length > 0) {
      params.set(
        "videos",
        uploadedVideoParts
          .map((part) => part.id)
          .filter(Boolean)
          .join(","),
      );
    }
    params.set("metadata", metadataFileId);
    if (consoleFileId) {
      params.set("console", consoleFileId);
    }
    if (networkFileId) {
      params.set("network", networkFileId);
    }
    if (websocketFileId) {
      params.set("websocket", websocketFileId);
    }

    const recordingUrl = buildExternalPlayerUrl(params);
    clearCapturedMedia({ clearBlob: true });

    return { ok: true, recordingUrl };
  } catch (e) {
    console.error("[Google Drive Upload] Error:", e);
    return { ok: false, error: (e as Error).message };
  }
}
