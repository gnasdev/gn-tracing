import { RecorderManager } from "./recorder-manager";
import { CdpManager } from "./cdp-manager";
import { StorageManager } from "./storage-manager";
import { GoogleDriveAuth } from "./google-drive-auth";
import { buildExternalPlayerUrl } from "../shared/player-host";
import type { ServiceWorkerMessage, MessageResponse, RecordingStatus, UploadState } from "../types/messages";

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

const uploadState: UploadState = {
  isUploading: false,
  progress: 0,
  message: "",
  recordingUrl: null,
  error: null,
};

// Storage key for state sync
const STORAGE_KEY_STATE = "gn_tracing_state";

// Save current state to storage for popup sync
async function saveStateToStorage(): Promise<void> {
  try {
    const gdStatus = await googleAuth.getStatus();
    const data = {
      recording: getStatus(),
      upload: getUploadState(),
      googleDrive: {
        isConnected: gdStatus.isConnected,
      },
    };
    await chrome.storage.session.set({ [STORAGE_KEY_STATE]: data });
  } catch {
    // Ignore storage errors
  }
}

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

// Forward progress messages from offscreen to popup and track upload state
chrome.runtime.onMessage.addListener((message: any, sender, sendResponse) => {
  if (message.target === "offscreen" && message.type === "UPLOAD_PROGRESS") {
    // Update upload state
    if (message.data) {
      const { step, total, message: msg } = message.data;
      uploadState.isUploading = true;
      uploadState.progress = (step / total) * 100;
      uploadState.message = msg;
    }
    // Save to storage for popup sync (fire and forget is ok for progress)
    void saveStateToStorage();
    // Forward to popup
    void chrome.runtime.sendMessage(message);
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (state.isRecording && tabId === state.tabId) {
    try {
      await stopRecording();
    } catch {
      // Fallback: force reset state if stopRecording fails
      state.isRecording = false;
      state.tabId = null;
      await saveStateToStorage();
    }
  }
});

async function handleMessage(message: ServiceWorkerMessage, _sender: chrome.runtime.MessageSender): Promise<MessageResponse | RecordingStatus | UploadState> {
  switch (message.action) {
    case "START_RECORDING":
      return await startRecording(message.tabId!);
    case "STOP_RECORDING":
      return await stopRecording();
    case "GET_STATUS":
      return getStatus();
    case "UPLOAD_TO_GOOGLE_DRIVE":
      return await uploadToGoogleDrive();
    case "GET_UPLOAD_STATE":
      return getUploadState();
    case "GOOGLE_DRIVE_CONNECT": {
      const result = await googleAuth.launchOAuthFlow();
      if (result.ok) {
        await saveStateToStorage();
      }
      return result;
    }
    case "GOOGLE_DRIVE_DISCONNECT": {
      const result = await googleAuth.disconnect();
      await saveStateToStorage();
      return result;
    }
    case "GOOGLE_DRIVE_STATUS":
      const status = await googleAuth.getStatus();
      return { ok: true, ...status };
    case "GET_GOOGLE_DRIVE_TOKEN":
      const token = await googleAuth.getAuthToken();
      return { ok: true, token };
    case "RECORDING_COMPLETE":
      recorder.onRecordingComplete();
      return { ok: true };
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

    // Save state to storage for popup sync
    await saveStateToStorage();

    return { ok: true };
  } catch (e) {
    try { await cdp.detach(); } catch {}
    try { await recorder.cleanup(); } catch {}
    state.isRecording = false;
    state.tabId = null;
    state.startTime = null;
    state.stopTime = null;
    await saveStateToStorage();
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
    cdp.releaseSourceMaps();

    chrome.action.setBadgeText({ text: "" });
    chrome.alarms.clear("gn-tracing-keepalive");

    // Save state to storage for popup sync
    await saveStateToStorage();

    return { ok: true };
  } catch (e) {
    await saveStateToStorage();
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

function getUploadState(): UploadState {
  return { ...uploadState };
}

function normalizeRecordingUrl(recordingUrl: string | null | undefined): string | null {
  if (!recordingUrl) {
    return null;
  }

  try {
    const parsed = new URL(recordingUrl);
    if (parsed.protocol === "chrome-extension:" || parsed.pathname.endsWith("/player/player.html")) {
      return buildExternalPlayerUrl(parsed.searchParams);
    }
    return recordingUrl;
  } catch {
    return recordingUrl;
  }
}

async function uploadToGoogleDrive(): Promise<MessageResponse> {
  try {
    // Reset upload state at start
    uploadState.isUploading = true;
    uploadState.progress = 0;
    uploadState.message = "Preparing upload...";
    uploadState.recordingUrl = null;
    uploadState.error = null;

    // Save initial state
    await saveStateToStorage();

    // Get auth token
    const authToken = await googleAuth.getAuthToken();
    if (!authToken) {
      uploadState.isUploading = false;
      uploadState.error = "Not connected to Google Drive. Please connect first.";
      await saveStateToStorage();
      return { ok: false, error: uploadState.error };
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
      const normalizedRecordingUrl = normalizeRecordingUrl(result.recordingUrl);
      uploadState.isUploading = false;
      uploadState.progress = 100;
      uploadState.message = "Upload complete!";
      uploadState.recordingUrl = normalizedRecordingUrl;
      storage.clear();
      recorder.clearRecording();
      state.tabId = null;
      state.startTime = null;
      state.stopTime = null;
      state.tabUrl = null;
      await saveStateToStorage();
      return { ok: true, recordingUrl: normalizedRecordingUrl || undefined };
    }
    uploadState.isUploading = false;
    uploadState.error = (result && result.error) || "Upload failed";
    await saveStateToStorage();
    return { ok: false, error: uploadState.error };
  } catch (e) {
    uploadState.isUploading = false;
    uploadState.error = (e as Error).message;
    await saveStateToStorage();
    return { ok: false, error: uploadState.error };
  }
}
