let recorder = null;
let chunks = [];
let recordedBlob = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== "offscreen") return false;

  switch (message.type) {
    case "START_CAPTURE":
      startCapture(message.data.streamId)
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    case "STOP_CAPTURE":
      stopCapture();
      sendResponse({ ok: true });
      return false;

    case "CREATE_ZIP":
      createZip(message.data)
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;

    case "UPLOAD_TO_SERVER":
      uploadToServer(message.data)
        .then((result) => sendResponse(result))
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
  }
});

async function startCapture(streamId) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
        maxWidth: 1920,
        maxHeight: 1080,
        maxFrameRate: 30,
      },
    },
  });

  // Pass audio through so the user can still hear the tab
  const audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(stream);
  source.connect(audioCtx.destination);

  // Choose best available codec
  const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
    ? "video/webm;codecs=vp9,opus"
    : "video/webm;codecs=vp8,opus";

  recorder = new MediaRecorder(stream, { mimeType });
  chunks = [];
  recordedBlob = null;

  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  recorder.onstop = () => {
    recordedBlob = new Blob(chunks, { type: recorder.mimeType });
    chunks = [];

    // Stop all tracks
    stream.getTracks().forEach((t) => t.stop());

    chrome.runtime.sendMessage({
      action: "RECORDING_COMPLETE",
      data: { mimeType: recorder.mimeType, size: recordedBlob.size },
    });
  };

  recorder.start(1000);
}

function stopCapture() {
  if (recorder && recorder.state !== "inactive") {
    recorder.stop();
  }
}

async function uploadToServer(data) {
  const formData = new FormData();

  if (recordedBlob) {
    formData.append("video", recordedBlob, "recording.webm");
  }

  formData.append("consoleLogs", data.consoleLogs);
  formData.append("networkRequests", data.networkRequests);
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

async function createZip(data) {
  const zip = new JSZip();

  // Add video
  if (recordedBlob) {
    zip.file("recording.webm", recordedBlob);
  }

  // Add console logs
  if (data.consoleLogs) {
    zip.file("console-logs.json", data.consoleLogs);
  }

  // Add network requests
  if (data.networkRequests) {
    zip.file("network-requests.json", data.networkRequests);
  }

  // Add WebSocket logs
  if (data.webSocketLogs) {
    zip.file("websocket-logs.json", data.webSocketLogs);
  }

  // Add metadata
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
