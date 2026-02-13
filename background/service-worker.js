import { RecorderManager } from "./recorder-manager.js";
import { CdpManager } from "./cdp-manager.js";
import { StorageManager } from "./storage-manager.js";

const storage = new StorageManager();
const recorder = new RecorderManager();
const cdp = new CdpManager(storage);

const state = {
  isRecording: false,
  tabId: null,
  startTime: null,
  tabUrl: null,
};

// Keep service worker alive during recording
let keepAliveAlarm = null;

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "ns-tracing-keepalive" && state.isRecording) {
    // Just waking up the service worker
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Filter messages meant for offscreen document
  if (message.target === "offscreen") return false;

  handleMessage(message, sender).then(sendResponse);
  return true;
});

// Handle tab close
chrome.tabs.onRemoved.addListener((tabId) => {
  if (state.isRecording && tabId === state.tabId) {
    stopRecording();
  }
});

async function handleMessage(message, sender) {
  switch (message.action) {
    case "START_RECORDING":
      return await startRecording(message.tabId);
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
      return await handleZipReady(message.data);
    default:
      return { ok: false, error: "Unknown action" };
  }
}

async function startRecording(tabId) {
  if (state.isRecording) {
    return { ok: false, error: "Already recording" };
  }

  try {
    state.tabId = tabId;

    // Get tab info
    const tab = await chrome.tabs.get(tabId);
    state.tabUrl = tab.url;

    // Clear previous data
    storage.clear();

    // Start CDP capture and video recording in parallel
    await Promise.all([
      cdp.attach(tabId),
      recorder.startCapture(tabId),
    ]);

    state.isRecording = true;
    state.startTime = Date.now();

    // Set badge
    chrome.action.setBadgeText({ text: "REC" });
    chrome.action.setBadgeBackgroundColor({ color: "#ef233c" });

    // Start keepalive alarm
    chrome.alarms.create("ns-tracing-keepalive", { periodInMinutes: 0.4 });

    return { ok: true };
  } catch (e) {
    // Cleanup on failure
    try { await cdp.detach(); } catch {}
    try { await recorder.cleanup(); } catch {}
    state.isRecording = false;
    state.tabId = null;
    state.startTime = null;
    return { ok: false, error: e.message };
  }
}

async function stopRecording() {
  if (!state.isRecording) {
    return { ok: false, error: "Not recording" };
  }

  try {
    state.isRecording = false;

    // Flush pending sourcemap fetches while debugger is still attached
    await cdp.flushSourceMaps();

    // Stop all capture systems
    await Promise.allSettled([
      recorder.stopCapture(),
      cdp.detach(),
    ]);

    // Resolve sourcemaps in stored entries
    storage.resolveSourceMaps(cdp.sourceMapResolver);

    // Clear badge
    chrome.action.setBadgeText({ text: "" });

    // Stop keepalive
    chrome.alarms.clear("ns-tracing-keepalive");

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function getStatus() {
  return {
    isRecording: state.isRecording,
    tabId: state.tabId,
    startTime: state.startTime,
    consoleLogCount: storage.getConsoleLogCount(),
    networkRequestCount: storage.getNetworkEntryCount(),
    hasRecording: recorder.hasRecording,
  };
}

async function downloadResults() {
  try {
    const consoleLogs = storage.exportConsoleJSON();
    const networkRequests = storage.exportNetworkJSON();
    const webSocketLogs = storage.exportWebSocketJSON();
    const duration = state.startTime ? Date.now() - state.startTime : 0;

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
    return { ok: false, error: e.message };
  }
}

async function uploadRecording() {
  try {
    const consoleLogs = storage.exportConsoleJSON();
    const networkRequests = storage.exportNetworkJSON();
    const webSocketLogs = storage.exportWebSocketJSON();
    const duration = state.startTime ? Date.now() - state.startTime : 0;
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
    });

    if (result && result.ok) {
      return { ok: true, recordingUrl: result.recordingUrl };
    }
    return { ok: false, error: (result && result.error) || "Upload failed" };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function handleZipReady(data) {
  try {
    await chrome.downloads.download({
      url: data.url,
      filename: data.filename,
      saveAs: true,
    });

    // Cleanup after download
    await recorder.cleanup();
    state.tabId = null;
    state.startTime = null;

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
