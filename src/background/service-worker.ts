import { RecorderManager } from "./recorder-manager";
import { CdpManager } from "./cdp-manager";
import { StorageManager } from "./storage-manager";
import { GoogleDriveAuth } from "./google-drive-auth";
import { buildExternalPlayerUrl } from "../shared/player-host";
import type { ProgressItemSnapshot, RecordingPhase, ServiceWorkerMessage, MessageResponse, RecordingStatus, UploadState } from "../types/messages";

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
  uploadedBytes: 0,
  totalBytes: 0,
  message: "",
  items: [],
  recordingUrl: null,
  error: null,
};

const googleDriveState = {
  isConnected: false,
  checkedAt: 0,
};

let phaseOverride: RecordingPhase | null = null;

// Storage key for state sync
const STORAGE_KEY_STATE = "gn_tracing_state";

interface PersistedPopupState {
  recording?: Partial<RecordingStatus>;
  upload?: Partial<UploadState> | null;
  googleDrive?: {
    isConnected?: boolean;
  } | null;
}

interface OffscreenCaptureState {
  ok: boolean;
  isRecording?: boolean;
  hasRecording?: boolean;
  recordedBytes?: number;
}

function getRecordingPhase(): RecordingPhase {
  if (phaseOverride) {
    return phaseOverride;
  }
  if (uploadState.isUploading) {
    return "uploading";
  }
  if (state.isRecording) {
    return "recording";
  }
  if (recorder.hasRecording) {
    return "recorded";
  }
  return "idle";
}

function resetUploadState(): void {
  uploadState.isUploading = false;
  uploadState.progress = 0;
  uploadState.uploadedBytes = 0;
  uploadState.totalBytes = 0;
  uploadState.message = "";
  uploadState.items = [];
  uploadState.recordingUrl = null;
  uploadState.error = null;
}

async function loadPersistedPopupState(): Promise<PersistedPopupState | null> {
  try {
    const result = await chrome.storage.session.get(STORAGE_KEY_STATE);
    return (result[STORAGE_KEY_STATE] as PersistedPopupState | undefined) || null;
  } catch {
    return null;
  }
}

async function probeOffscreenCaptureState(): Promise<OffscreenCaptureState | null> {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    });
    if (contexts.length === 0) {
      return null;
    }

    return await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "GET_CAPTURE_STATE",
    }) as OffscreenCaptureState;
  } catch {
    return null;
  }
}

async function refreshGoogleDriveState(): Promise<void> {
  const status = await googleAuth.getStatus();
  googleDriveState.isConnected = status.isConnected;
  googleDriveState.checkedAt = Date.now();
}

// Save current state to storage for popup sync
async function saveStateToStorage(): Promise<void> {
  try {
    const data = {
      recording: getStatus(),
      upload: getUploadState(),
      googleDrive: {
        isConnected: googleDriveState.isConnected,
      },
    };
    await chrome.storage.session.set({ [STORAGE_KEY_STATE]: data });
  } catch {
    // Ignore storage errors
  }
}

async function syncRuntimeState(): Promise<void> {
  const persistedState = await loadPersistedPopupState();
  const offscreenState = await probeOffscreenCaptureState();

  phaseOverride = null;

  if (persistedState?.googleDrive && typeof persistedState.googleDrive.isConnected === "boolean") {
    googleDriveState.isConnected = persistedState.googleDrive.isConnected;
  }

  if (persistedState?.recording) {
    state.tabId = persistedState.recording.tabId ?? state.tabId;
    state.startTime = persistedState.recording.startTime ?? state.startTime;
    state.stopTime = persistedState.recording.stopTime ?? state.stopTime;
    state.tabUrl = persistedState.recording.tabUrl ?? state.tabUrl;
  }

  if (persistedState?.upload) {
    uploadState.isUploading = Boolean(persistedState.upload.isUploading);
    uploadState.progress = persistedState.upload.progress ?? 0;
    uploadState.uploadedBytes = persistedState.upload.uploadedBytes ?? 0;
    uploadState.totalBytes = persistedState.upload.totalBytes ?? 0;
    uploadState.message = persistedState.upload.message ?? "";
    uploadState.items = Array.isArray(persistedState.upload.items)
      ? persistedState.upload.items as ProgressItemSnapshot[]
      : [];
    uploadState.recordingUrl = persistedState.upload.recordingUrl ?? null;
    uploadState.error = persistedState.upload.error ?? null;
  }

  recorder.hydrateRecordingComplete(false);

  if (offscreenState?.ok) {
    const hasRecording = Boolean(offscreenState.hasRecording);
    const isRecording = Boolean(offscreenState.isRecording);

    recorder.hydrateRecordingComplete(hasRecording);
    state.isRecording = isRecording;

    if ((hasRecording || isRecording) && !uploadState.isUploading) {
      resetUploadState();
    }

    if (hasRecording && !state.stopTime) {
      state.stopTime = persistedState?.recording?.stopTime ?? Date.now();
    }

    if (!hasRecording && !isRecording && uploadState.isUploading) {
      resetUploadState();
      uploadState.error = "Upload was interrupted when the extension runtime restarted.";
      phaseOverride = "interrupted";
    }
  } else {
    const previousPhase = persistedState?.recording?.phase;
    if (previousPhase === "recording" || previousPhase === "uploading") {
      state.isRecording = false;
      recorder.hydrateRecordingComplete(false);
      resetUploadState();
      phaseOverride = "interrupted";
    }
  }

  await refreshGoogleDriveState();
  await saveStateToStorage();
}

void syncRuntimeState();

chrome.runtime.onStartup.addListener(() => {
  void syncRuntimeState();
});

chrome.runtime.onInstalled.addListener(() => {
  void syncRuntimeState();
});

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
      const {
        step,
        total,
        percent,
        uploadedBytes,
        totalBytes,
        message: msg,
        items,
      } = message.data;
      uploadState.isUploading = true;
      uploadState.progress = typeof percent === "number" ? percent : (step / total) * 100;
      uploadState.uploadedBytes = typeof uploadedBytes === "number" ? uploadedBytes : 0;
      uploadState.totalBytes = typeof totalBytes === "number" ? totalBytes : 0;
      uploadState.message = msg;
      uploadState.items = Array.isArray(items) ? items : [];
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
        await refreshGoogleDriveState();
        await saveStateToStorage();
      }
      return result;
    }
    case "GOOGLE_DRIVE_DISCONNECT": {
      const result = await googleAuth.disconnect();
      await refreshGoogleDriveState();
      await saveStateToStorage();
      return result;
    }
    case "GOOGLE_DRIVE_STATUS": {
      const status = await googleAuth.getStatus();
      googleDriveState.isConnected = status.isConnected;
      googleDriveState.checkedAt = Date.now();
      await saveStateToStorage();
      return { ok: true, ...status };
    }
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
    phaseOverride = null;
    resetUploadState();
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
    resetUploadState();
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
    phase: getRecordingPhase(),
    isRecording: state.isRecording,
    tabId: state.tabId,
    startTime: state.startTime,
    stopTime: state.stopTime,
    tabUrl: state.tabUrl,
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
    phaseOverride = null;
    resetUploadState();
    uploadState.isUploading = true;
    uploadState.message = "Uploading recording...";

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
      uploadState.uploadedBytes = uploadState.totalBytes;
      uploadState.message = "Upload complete!";
      uploadState.recordingUrl = normalizedRecordingUrl;
      storage.clear();
      recorder.clearRecording();
      phaseOverride = null;
      state.tabId = null;
      state.startTime = null;
      state.stopTime = null;
      state.tabUrl = null;
      await saveStateToStorage();
      return { ok: true, recordingUrl: normalizedRecordingUrl || undefined };
    }
    uploadState.isUploading = false;
    phaseOverride = null;
    uploadState.error = (result && result.error) || "Upload failed";
    await saveStateToStorage();
    return { ok: false, error: uploadState.error };
  } catch (e) {
    uploadState.isUploading = false;
    phaseOverride = null;
    uploadState.error = (e as Error).message;
    await saveStateToStorage();
    return { ok: false, error: uploadState.error };
  }
}
