import { RecorderManager } from "./recorder-manager";
import { CdpManager } from "./cdp-manager";
import { StorageManager } from "./storage-manager";
import { GoogleDriveAuth } from "./google-drive-auth";
import type { ServiceWorkerMessage, MessageResponse, RecordingStatus } from "../types/messages";

const storage = new StorageManager();
const recorder = new RecorderManager();
const cdp = new CdpManager(storage);
const googleAuth = new GoogleDriveAuth();

// Initialize Google Auth
googleAuth.initialize();

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
  if (alarm.name === "gn-tracing-keepalive" && state.isRecording) {
    // Just waking up the service worker
  }
});

chrome.runtime.onMessage.addListener((message: ServiceWorkerMessage, sender, sendResponse) => {
  if (message.target === "offscreen") return false;

  handleMessage(message, sender).then(sendResponse);
  return true;
});

// Forward progress messages from offscreen to popup
chrome.runtime.onMessage.addListener((message: any, sender, sendResponse) => {
  if (message.target === "offscreen" && message.type === "UPLOAD_PROGRESS") {
    // Forward to popup
    chrome.runtime.sendMessage(message);
    sendResponse({ ok: true });
    return true;
  }
  return false;
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
    case "UPLOAD_TO_GOOGLE_DRIVE":
      return await uploadToGoogleDrive();
    case "GOOGLE_DRIVE_CONNECT":
      return await googleAuth.launchOAuthFlow();
    case "GOOGLE_DRIVE_DISCONNECT":
      return await googleAuth.disconnect();
    case "GOOGLE_DRIVE_STATUS":
      const status = await googleAuth.getStatus();
      return { ok: true, ...status };
    case "GET_GOOGLE_DRIVE_TOKEN":
      const token = await googleAuth.getAuthToken();
      return { ok: true, token };
    case "OPEN_POPUP":
      chrome.windows.create({
        type: "popup",
        url: chrome.runtime.getURL("popup/popup.html"),
        width: 320,
        height: 500,
      });
      return { ok: true };
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

    // Block recording on chrome:// URLs
    if (tab.url && tab.url.startsWith("chrome://")) {
      return { ok: false, error: "Cannot record chrome:// pages. Please open a regular webpage." };
    }

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

    chrome.alarms.create("gn-tracing-keepalive", { periodInMinutes: 0.4 });

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
    chrome.alarms.clear("gn-tracing-keepalive");

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

async function uploadToGoogleDrive(): Promise<MessageResponse> {
  try {
    // Get auth token
    const authToken = await googleAuth.getAuthToken();
    if (!authToken) {
      return { ok: false, error: "Not connected to Google Drive. Please connect first." };
    }

    const consoleLogs = storage.exportConsoleJSON();
    const networkRequests = storage.exportNetworkJSON();
    const webSocketLogs = storage.exportWebSocketJSON();
    const duration = state.startTime ? (state.stopTime || Date.now()) - state.startTime : 0;

    const result = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "UPLOAD_TO_GOOGLE_DRIVE",
      data: {
        consoleLogs,
        networkRequests,
        webSocketLogs,
        duration,
        url: state.tabUrl || "",
        startTime: state.startTime,
        authToken,
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
