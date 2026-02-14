import JSZip from "jszip";

let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let recordedBlob: Blob | null = null;

interface OffscreenIncomingMessage {
  target: string;
  type: string;
  data?: Record<string, unknown>;
}

chrome.runtime.onMessage.addListener((message: OffscreenIncomingMessage, _sender, sendResponse) => {
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

    case "UPLOAD_TO_SERVER":
      uploadToServer(message.data as unknown as UploadData)
        .then((result) => sendResponse(result))
        .catch((e: Error) => sendResponse({ ok: false, error: e.message }));
      return true;
  }
});

interface ZipData {
  consoleLogs?: string;
  networkRequests?: string;
  webSocketLogs?: string;
  duration: number;
  url: string;
  startTime: number | null;
}

interface UploadData extends ZipData {
  serverUrl: string;
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

  recorder.start(1000);
}

function stopCapture(): void {
  if (recorder && recorder.state !== "inactive") {
    recorder.stop();
  }
}

async function uploadToServer(data: UploadData): Promise<{ ok: boolean; recordingUrl?: string; error?: string }> {
  const formData = new FormData();

  if (recordedBlob) {
    formData.append("video", recordedBlob, "recording.webm");
  }

  formData.append("consoleLogs", data.consoleLogs || "[]");
  formData.append("networkRequests", data.networkRequests || "{}");
  if (data.webSocketLogs) {
    formData.append("webSocketLogs", data.webSocketLogs);
  }
  formData.append(
    "metadata",
    JSON.stringify({
      timestamp: new Date().toISOString(),
      duration: data.duration,
      url: data.url,
      startTime: data.startTime,
      extension: "ns-tracing",
      version: "1.0.0",
    })
  );

  const response = await fetch(`${data.serverUrl}/api/recordings`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Server responded with ${response.status}`);
  }

  const result = await response.json();
  return { ok: true, recordingUrl: result.url };
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
        extension: "ns-tracing",
        version: "1.0.0",
      },
      null,
      2
    )
  );

  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);

  const now = new Date();
  const dateStr = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `ns-tracing-${dateStr}.zip`;

  chrome.runtime.sendMessage({
    action: "ZIP_READY",
    data: { url, filename },
  });
}
