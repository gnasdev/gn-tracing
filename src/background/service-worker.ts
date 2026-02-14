import { RecorderManager } from "./recorder-manager";
import { CdpManager } from "./cdp-manager";
import { StorageManager } from "./storage-manager";
import type { ServiceWorkerMessage, MessageResponse, RecordingStatus } from "../types/messages";

const storage = new StorageManager();
const recorder = new RecorderManager();
const cdp = new CdpManager(storage);

interface RecordingState {
  isRecording: boolean;
  tabId: number | null;
  startTime: number | null;
  stopTime: number | null;
  tabUrl: string | null;
}

const state: RecordingState = {
  isRecording: false,
  tabId: null,
  startTime: null,
  stopTime: null,
  tabUrl: null,
};

// Keep service worker alive during recording
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "ns-tracing-keepalive" && state.isRecording) {
    // Just waking up the service worker
  }
});

chrome.runtime.onMessage.addListener((message: ServiceWorkerMessage, sender, sendResponse) => {
  if (message.target === "offscreen") return false;

  handleMessage(message, sender).then(sendResponse);
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (state.isRecording && tabId === state.tabId) {
    stopRecording();
  }
});

async function handleMessage(message: ServiceWorkerMessage, _sender: chrome.runtime.MessageSender): Promise<MessageResponse | RecordingStatus> {
  switch (message.action) {
    case "START_RECORDING":
      return await startRecording(message.tabId!);
    case "STOP_RECORDING":
      return await stopRecording();
    case "GET_STATUS":
      return getStatus();
    case "DOWNLOAD_RESULTS":
      return await downloadResults();
    case "UPLOAD_RECORDING":
      return await uploadRecording();
    case "SET_SERVER_URL":
      await chrome.storage.local.set({ serverUrl: message.url });
      return { ok: true };
    case "GET_SERVER_URL": {
      const stored = await chrome.storage.local.get({ serverUrl: "http://localhost:3000" });
      return { ok: true, url: stored.serverUrl };
    }
    case "RECORDING_COMPLETE":
      recorder.onRecordingComplete();
      return { ok: true };
    case "ZIP_READY":
      return await handleZipReady(message.data as { url: string; filename: string });
    default:
      return { ok: false, error: "Unknown action" };
  }
}

async function startRecording(tabId: number): Promise<MessageResponse> {
  if (state.isRecording) {
    return { ok: false, error: "Already recording" };
  }

  try {
    state.tabId = tabId;

    const tab = await chrome.tabs.get(tabId);
    state.tabUrl = tab.url ?? null;

    storage.clear();

    state.stopTime = null;
    state.startTime = Date.now();

    await Promise.all([
      cdp.attach(tabId),
      recorder.startCapture(tabId),
    ]);

    state.isRecording = true;

    chrome.action.setBadgeText({ text: "REC" });
    chrome.action.setBadgeBackgroundColor({ color: "#ef233c" });

    chrome.alarms.create("ns-tracing-keepalive", { periodInMinutes: 0.4 });

    return { ok: true };
  } catch (e) {
    try { await cdp.detach(); } catch {}
    try { await recorder.cleanup(); } catch {}
    state.isRecording = false;
    state.tabId = null;
    state.startTime = null;
    state.stopTime = null;
    return { ok: false, error: (e as Error).message };
  }
}

async function stopRecording(): Promise<MessageResponse> {
  if (!state.isRecording) {
    return { ok: false, error: "Not recording" };
  }

  try {
    state.isRecording = false;
    state.stopTime = Date.now();

    await cdp.flushSourceMaps();

    await Promise.allSettled([
      recorder.stopCapture(),
      cdp.detach(),
    ]);

    storage.resolveSourceMaps(cdp.sourceMapResolver);

    chrome.action.setBadgeText({ text: "" });
    chrome.alarms.clear("ns-tracing-keepalive");

    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function getStatus(): RecordingStatus {
  return {
    isRecording: state.isRecording,
    tabId: state.tabId,
    startTime: state.startTime,
    consoleLogCount: storage.getConsoleLogCount(),
    networkRequestCount: storage.getNetworkEntryCount(),
    hasRecording: recorder.hasRecording,
  };
}

async function downloadResults(): Promise<MessageResponse> {
  try {
    const consoleLogs = storage.exportConsoleJSON();
    const networkRequests = storage.exportNetworkJSON();
    const webSocketLogs = storage.exportWebSocketJSON();
    const duration = state.startTime ? (state.stopTime || Date.now()) - state.startTime : 0;

    await recorder.createZip({
      consoleLogs,
      networkRequests,
      webSocketLogs,
      duration,
      url: state.tabUrl || "",
      startTime: state.startTime,
    });

    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

async function uploadRecording(): Promise<MessageResponse> {
  try {
    const consoleLogs = storage.exportConsoleJSON();
    const networkRequests = storage.exportNetworkJSON();
    const webSocketLogs = storage.exportWebSocketJSON();
    const duration = state.startTime ? (state.stopTime || Date.now()) - state.startTime : 0;
    const { serverUrl } = await chrome.storage.local.get({ serverUrl: "http://localhost:3000" });

    const result = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "UPLOAD_TO_SERVER",
      data: {
        consoleLogs,
        networkRequests,
        webSocketLogs,
        duration,
        url: state.tabUrl || "",
        startTime: state.startTime,
        serverUrl,
      },
    }) as MessageResponse;

    if (result && result.ok) {
      return { ok: true, recordingUrl: result.recordingUrl };
    }
    return { ok: false, error: (result && result.error) || "Upload failed" };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

async function handleZipReady(data: { url: string; filename: string }): Promise<MessageResponse> {
  try {
    await chrome.downloads.download({
      url: data.url,
      filename: data.filename,
      saveAs: true,
    });

    await recorder.cleanup();
    state.tabId = null;
    state.startTime = null;
    state.stopTime = null;

    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
