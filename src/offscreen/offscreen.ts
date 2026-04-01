import JSZip from "jszip";

let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let recordedBlob: Blob | null = null;

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

      case "CREATE_ZIP":
        createZip(message.data as unknown as ZipData)
          .then(() => sendResponse({ ok: true }))
          .catch((e: Error) => sendResponse({ ok: false, error: e.message }));
        return true;

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

function sendProgress(step: number, total: number, message: string): void {
  chrome.runtime.sendMessage({
    target: "offscreen",
    type: "UPLOAD_PROGRESS",
    data: { step, total, message },
  });
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
  const audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(stream);
  source.connect(audioCtx.destination);

  const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
    ? "video/webm;codecs=vp9,opus"
    : "video/webm;codecs=vp8,opus";

  recorder = new MediaRecorder(stream, { mimeType });
  chunks = [];
  recordedBlob = null;

  recorder.ondataavailable = (e: BlobEvent) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  recorder.onstop = () => {
    recordedBlob = new Blob(chunks, { type: recorder!.mimeType });
    chunks = [];

    stream.getTracks().forEach((t) => t.stop());

    chrome.runtime.sendMessage({
      action: "RECORDING_COMPLETE",
      data: { mimeType: recorder!.mimeType, size: recordedBlob!.size },
    });
  };

  recorder.start();
}

function stopCapture(): void {
  if (recorder && recorder.state !== "inactive") {
    recorder.stop();
  }
}

async function uploadToGoogleDrive(
  data: GoogleDriveUploadData,
): Promise<{ ok: boolean; recordingUrl?: string; error?: string }> {
  const now = new Date();
  const dateStr = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const baseName = `gn-web-tracing-${dateStr}`;

  try {
    // Upload video first (largest file, separate progress)
    let videoFileId: string | undefined;
    if (recordedBlob) {
      sendProgress(1, 5, "Uploading video...");
      const videoFormData = new FormData();
      videoFormData.append(
        "metadata",
        new Blob([JSON.stringify({ name: `${baseName}.webm` })], { type: "application/json" })
      );
      videoFormData.append("file", recordedBlob, `${baseName}.webm`);

      const videoResponse = await fetch(
        "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id&supportsAllDrives=true",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${data.authToken}`,
          },
          body: videoFormData,
        }
      );

      if (!videoResponse.ok) {
        const error = await videoResponse.json().catch(() => ({}));
        throw new Error(error.error?.message || `Video upload failed with status ${videoResponse.status}`);
      }

      const videoResult = await videoResponse.json();
      videoFileId = videoResult.id;

      // Make video shareable
      await fetch(
        `https://www.googleapis.com/drive/v3/files/${videoFileId}/permissions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${data.authToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            type: "anyone",
            role: "reader",
          }),
        }
      );
    }

    // Upload console, network, and websocket logs in parallel
    sendProgress(2, 5, "Uploading logs...");

    const uploadPromises: Promise<{ type: string; fileId?: string }>[] = [];

    // Console logs
    if (data.consoleLogs) {
      uploadPromises.push(
        (async () => {
          const consoleFormData = new FormData();
          consoleFormData.append(
            "metadata",
            new Blob([JSON.stringify({ name: `${baseName}-console.json` })], { type: "application/json" })
          );
          consoleFormData.append("file", new Blob([data.consoleLogs], { type: "application/json" }), `${baseName}-console.json`);

          const consoleResponse = await fetch(
            "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id&supportsAllDrives=true",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${data.authToken}`,
              },
              body: consoleFormData,
            }
          );

          if (consoleResponse.ok) {
            const consoleResult = await consoleResponse.json();
            const consoleFileId = consoleResult.id;

            // Make shareable
            await fetch(
              `https://www.googleapis.com/drive/v3/files/${consoleFileId}/permissions`,
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${data.authToken}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  type: "anyone",
                  role: "reader",
                }),
              }
            );
            return { type: "console", fileId: consoleFileId };
          }
          return { type: "console" };
        })()
      );
    }

    // Network logs
    if (data.networkRequests) {
      uploadPromises.push(
        (async () => {
          const networkFormData = new FormData();
          networkFormData.append(
            "metadata",
            new Blob([JSON.stringify({ name: `${baseName}-network.json` })], { type: "application/json" })
          );
          networkFormData.append("file", new Blob([data.networkRequests], { type: "application/json" }), `${baseName}-network.json`);

          const networkResponse = await fetch(
            "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id&supportsAllDrives=true",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${data.authToken}`,
              },
              body: networkFormData,
            }
          );

          if (networkResponse.ok) {
            const networkResult = await networkResponse.json();
            const networkFileId = networkResult.id;

            // Make shareable
            await fetch(
              `https://www.googleapis.com/drive/v3/files/${networkFileId}/permissions`,
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${data.authToken}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  type: "anyone",
                  role: "reader",
                }),
              }
            );
            return { type: "network", fileId: networkFileId };
          }
          return { type: "network" };
        })()
      );
    }

    // WebSocket logs
    if (data.webSocketLogs) {
      uploadPromises.push(
        (async () => {
          const wsFormData = new FormData();
          wsFormData.append(
            "metadata",
            new Blob([JSON.stringify({ name: `${baseName}-websocket.json` })], { type: "application/json" })
          );
          wsFormData.append("file", new Blob([data.webSocketLogs], { type: "application/json" }), `${baseName}-websocket.json`);

          const wsResponse = await fetch(
            "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id&supportsAllDrives=true",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${data.authToken}`,
              },
              body: wsFormData,
            }
          );

          if (wsResponse.ok) {
            const wsResult = await wsResponse.json();
            const websocketFileId = wsResult.id;

            // Make shareable
            await fetch(
              `https://www.googleapis.com/drive/v3/files/${websocketFileId}/permissions`,
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${data.authToken}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  type: "anyone",
                  role: "reader",
                }),
              }
            );
            return { type: "websocket", fileId: websocketFileId };
          }
          return { type: "websocket" };
        })()
      );
    }

    // Wait for all log uploads to complete
    const uploadResults = await Promise.all(uploadPromises);

    let consoleFileId: string | undefined;
    let networkFileId: string | undefined;
    let websocketFileId: string | undefined;

    for (const result of uploadResults) {
      if (result.type === "console") consoleFileId = result.fileId;
      if (result.type === "network") networkFileId = result.fileId;
      if (result.type === "websocket") websocketFileId = result.fileId;
    }

    // Upload metadata (needs file IDs from above uploads)
    let metadataFileId: string | undefined;
    sendProgress(5, 5, "Uploading metadata...");
    const metadata = {
      timestamp: new Date().toISOString(),
      duration: data.duration,
      url: data.url,
      startTime: data.startTime,
      extension: "gn-web-tracing",
      version: "1.0.0",
      videoFileId,
      consoleFileId,
      networkFileId,
      websocketFileId,
    };
    const metadataFormData = new FormData();
    metadataFormData.append(
      "metadata",
      new Blob([JSON.stringify({ name: `${baseName}-metadata.json` })], { type: "application/json" })
    );
    metadataFormData.append("file", new Blob([JSON.stringify(metadata, null, 2)], { type: "application/json" }), `${baseName}-metadata.json`);

    const metadataResponse = await fetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id&supportsAllDrives=true",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${data.authToken}`,
        },
        body: metadataFormData,
      }
    );

    if (!metadataResponse.ok) {
      const error = await metadataResponse.json().catch(() => ({}));
      throw new Error(error.error?.message || `Metadata upload failed`);
    }

    const metadataResult = await metadataResponse.json();
    metadataFileId = metadataResult.id;

    // Make metadata shareable
    await fetch(
      `https://www.googleapis.com/drive/v3/files/${metadataFileId}/permissions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${data.authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "anyone",
          role: "reader",
        }),
      }
    );

    // Build player URL with file IDs as query params
    const playerBaseUrl = chrome.runtime.getURL("dist/player/player.html");
    const params = new URLSearchParams();
    if (videoFileId) params.set("video", videoFileId);
    if (consoleFileId) params.set("console", consoleFileId);
    if (networkFileId) params.set("network", networkFileId);
    if (websocketFileId) params.set("websocket", websocketFileId);
    if (metadataFileId) params.set("metadata", metadataFileId);

    const recordingUrl = `${playerBaseUrl}?${params.toString()}`;
    return { ok: true, recordingUrl };

  } catch (e) {
    console.error("[Google Drive Upload] Error:", e);
    return { ok: false, error: (e as Error).message };
  }
}

async function createZip(data: ZipData): Promise<void> {
  const zip = new JSZip();

  if (recordedBlob) {
    zip.file("recording.webm", recordedBlob);
  }

  if (data.consoleLogs) {
    zip.file("console-logs.json", data.consoleLogs);
  }

  if (data.networkRequests) {
    zip.file("network-requests.json", data.networkRequests);
  }

  if (data.webSocketLogs) {
    zip.file("websocket-logs.json", data.webSocketLogs);
  }

  zip.file(
    "metadata.json",
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        duration: data.duration,
        url: data.url,
        startTime: data.startTime,
        extension: "gn-web-tracing",
        version: "1.0.0",
      },
      null,
      2,
    ),
  );

  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);

  const now = new Date();
  const dateStr = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `gn-web-tracing-${dateStr}.zip`;

  chrome.runtime.sendMessage({
    action: "ZIP_READY",
    data: { url, filename },
  });
}
