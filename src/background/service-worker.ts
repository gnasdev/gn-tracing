import { RecorderManager } from "./recorder-manager";
import { CdpManager } from "./cdp-manager";
import { StorageManager } from "./storage-manager";
import { GoogleDriveAuth } from "./google-drive-auth";
import { buildExternalPlayerUrl } from "../shared/player-host";
import { parseGoogleDriveFolderInput } from "../shared/google-drive-folder";
import type {
  MessageResponse,
  PopupState,
  ProgressItemSnapshot,
  RecordingSessionSummary,
  RecordingStatus,
  ServiceWorkerMessage,
  UploadHistoryEntry,
  UploadSettings,
} from "../types/messages";

const storage = new StorageManager();
const recorder = new RecorderManager();
const cdp = new CdpManager(storage);
const googleAuth = new GoogleDriveAuth();

void googleAuth.initialize();

interface ActiveRecordingState {
  sessionId: string | null;
  isRecording: boolean;
  isPaused: boolean;
  tabId: number | null;
  startTime: number | null;
  stopTime: number | null;
  tabUrl: string | null;
  pausedAt: number | null;
  accumulatedPausedMs: number;
}

interface SessionArtifacts {
  consoleLogs?: string;
  networkRequests?: string;
  webSocketLogs?: string;
  duration: number;
  url: string;
  startTime: number | null;
  stopTime: number | null;
}

interface PersistedPopupState extends PopupState {}

interface OffscreenCaptureState {
  ok: boolean;
  isRecording?: boolean;
  isPaused?: boolean;
  activeSessionId?: string | null;
  snapshotSessionIds?: string[];
}

interface UploadSettingsStore {
  folderInput: string;
  folderId: string | null;
}

interface UploadHistoryFileMap {
  [scopeKey: string]: string;
}

interface UploadSuccessResult {
  ok: true;
  recordingUrl?: string;
  folderId?: string;
  indexFileId?: string;
}

const STORAGE_KEY_STATE = "gn_tracing_state";
const STORAGE_KEY_ARTIFACTS = "gn_tracing_session_artifacts";
const STORAGE_KEY_SETTINGS = "gn_tracing_upload_settings";
const STORAGE_KEY_HISTORY = "gn_tracing_upload_history";
const STORAGE_KEY_HISTORY_FILES = "gn_tracing_upload_history_files";
const UPLOAD_HISTORY_FILENAME = "gn-tracing-upload-history.json";
const MAX_UPLOAD_HISTORY_ITEMS = 20;

const activeRecording: ActiveRecordingState = {
  sessionId: null,
  isRecording: false,
  isPaused: false,
  tabId: null,
  startTime: null,
  stopTime: null,
  tabUrl: null,
  pausedAt: null,
  accumulatedPausedMs: 0,
};

let sessions: RecordingSessionSummary[] = [];
let sessionArtifacts: Record<string, SessionArtifacts> = {};
const activeUploadTasks = new Map<string, Promise<void>>();

const googleDriveState = {
  isConnected: false,
  checkedAt: 0,
};

let cachedUploadSettings: UploadSettingsStore = {
  folderInput: "",
  folderId: null,
};
let hasLoadedUploadSettings = false;
let cachedUploadHistory: UploadHistoryEntry[] = [];
let hasLoadedUploadHistory = false;

function createSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function cloneProgressItems(items: ProgressItemSnapshot[]): ProgressItemSnapshot[] {
  return items.map((item) => ({ ...item }));
}

function getElapsedMs(now = Date.now()): number {
  if (!activeRecording.startTime) {
    return 0;
  }
  const pausedDuration = activeRecording.pausedAt ? Math.max(0, now - activeRecording.pausedAt) : 0;
  return Math.max(0, now - activeRecording.startTime - activeRecording.accumulatedPausedMs - pausedDuration);
}

function resetActiveRecordingState(): void {
  activeRecording.sessionId = null;
  activeRecording.isRecording = false;
  activeRecording.isPaused = false;
  activeRecording.tabId = null;
  activeRecording.startTime = null;
  activeRecording.stopTime = null;
  activeRecording.tabUrl = null;
  activeRecording.pausedAt = null;
  activeRecording.accumulatedPausedMs = 0;
  recorder.clearActiveSession();
}

function sortSessions(items: RecordingSessionSummary[]): RecordingSessionSummary[] {
  return [...items].sort((left, right) => {
    const rightTs = right.stopTime || right.startTime || 0;
    const leftTs = left.stopTime || left.startTime || 0;
    return rightTs - leftTs;
  });
}

function getSession(sessionId: string): RecordingSessionSummary | undefined {
  return sessions.find((session) => session.id === sessionId);
}

function setSession(session: RecordingSessionSummary): void {
  const existingIndex = sessions.findIndex((item) => item.id === session.id);
  if (existingIndex >= 0) {
    sessions[existingIndex] = session;
  } else {
    sessions.push(session);
  }
  sessions = sortSessions(sessions);
}

function patchSession(sessionId: string, patch: Partial<RecordingSessionSummary>): RecordingSessionSummary | null {
  const existing = getSession(sessionId);
  if (!existing) {
    return null;
  }
  const updated: RecordingSessionSummary = {
    ...existing,
    ...patch,
    items: patch.items ? cloneProgressItems(patch.items) : cloneProgressItems(existing.items),
  };
  setSession(updated);
  return updated;
}

function getRecordingStatus(): RecordingStatus | null {
  if (!activeRecording.sessionId && !activeRecording.isRecording && !activeRecording.isPaused) {
    return null;
  }

  return {
    phase: activeRecording.isRecording
      ? (activeRecording.isPaused ? "paused" : "recording")
      : "idle",
    sessionId: activeRecording.sessionId,
    isRecording: activeRecording.isRecording,
    isPaused: activeRecording.isPaused,
    tabId: activeRecording.tabId,
    startTime: activeRecording.startTime,
    stopTime: activeRecording.stopTime,
    tabUrl: activeRecording.tabUrl,
    elapsedMs: getElapsedMs(),
    consoleLogCount: storage.getConsoleLogCount(),
    networkRequestCount: storage.getNetworkEntryCount(),
  };
}

async function getUploadSettings(): Promise<UploadSettingsStore> {
  if (hasLoadedUploadSettings) {
    return cachedUploadSettings;
  }

  try {
    const result = await chrome.storage.local.get(STORAGE_KEY_SETTINGS);
    const stored = result[STORAGE_KEY_SETTINGS] as Partial<UploadSettingsStore> | undefined;
    cachedUploadSettings = {
      folderInput: typeof stored?.folderInput === "string" ? stored.folderInput : "",
      folderId: typeof stored?.folderId === "string" ? stored.folderId : null,
    };
  } catch {
    cachedUploadSettings = {
      folderInput: "",
      folderId: null,
    };
  }

  hasLoadedUploadSettings = true;
  return cachedUploadSettings;
}

async function saveUploadSettings(settings: UploadSettingsStore): Promise<void> {
  cachedUploadSettings = settings;
  hasLoadedUploadSettings = true;
  await chrome.storage.local.set({ [STORAGE_KEY_SETTINGS]: settings });
}

async function getUploadHistory(): Promise<UploadHistoryEntry[]> {
  if (hasLoadedUploadHistory) {
    return cachedUploadHistory;
  }

  try {
    const result = await chrome.storage.local.get(STORAGE_KEY_HISTORY);
    const history = result[STORAGE_KEY_HISTORY];
    cachedUploadHistory = Array.isArray(history) ? history as UploadHistoryEntry[] : [];
  } catch {
    cachedUploadHistory = [];
  }

  hasLoadedUploadHistory = true;
  return cachedUploadHistory;
}

async function saveUploadHistory(history: UploadHistoryEntry[]): Promise<void> {
  cachedUploadHistory = history.slice(0, MAX_UPLOAD_HISTORY_ITEMS);
  hasLoadedUploadHistory = true;
  await chrome.storage.local.set({
    [STORAGE_KEY_HISTORY]: cachedUploadHistory,
  });
}

async function getUploadHistoryFileMap(): Promise<UploadHistoryFileMap> {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY_HISTORY_FILES);
    const fileMap = result[STORAGE_KEY_HISTORY_FILES];
    if (!fileMap || typeof fileMap !== "object") {
      return {};
    }
    return fileMap as UploadHistoryFileMap;
  } catch {
    return {};
  }
}

async function saveUploadHistoryFileMap(fileMap: UploadHistoryFileMap): Promise<void> {
  await chrome.storage.local.set({
    [STORAGE_KEY_HISTORY_FILES]: fileMap,
  });
}

function getUploadHistoryScopeKey(folderId: string | null): string {
  return folderId || "root";
}

function getSettingsSnapshot(settings: UploadSettingsStore): UploadSettings {
  return {
    folderInput: settings.folderInput,
    folderId: settings.folderId,
  };
}

async function loadPersistedPopupState(): Promise<PersistedPopupState | null> {
  try {
    const result = await chrome.storage.session.get(STORAGE_KEY_STATE);
    return (result[STORAGE_KEY_STATE] as PersistedPopupState | undefined) || null;
  } catch {
    return null;
  }
}

async function loadPersistedArtifacts(): Promise<Record<string, SessionArtifacts>> {
  try {
    const result = await chrome.storage.session.get(STORAGE_KEY_ARTIFACTS);
    const stored = result[STORAGE_KEY_ARTIFACTS];
    if (!stored || typeof stored !== "object") {
      return {};
    }
    return stored as Record<string, SessionArtifacts>;
  } catch {
    return {};
  }
}

async function saveArtifactsToStorage(): Promise<void> {
  try {
    await chrome.storage.session.set({
      [STORAGE_KEY_ARTIFACTS]: sessionArtifacts,
    });
  } catch {
    // Ignore storage errors.
  }
}

async function refreshGoogleDriveState(): Promise<void> {
  const status = await googleAuth.getStatus();
  googleDriveState.isConnected = status.isConnected;
  googleDriveState.checkedAt = Date.now();
}

async function saveStateToStorage(): Promise<void> {
  try {
    const [settings, uploadHistory] = await Promise.all([
      getUploadSettings(),
      getUploadHistory(),
    ]);
    const popupState: PopupState = {
      recording: getRecordingStatus(),
      sessions: sortSessions(sessions),
      googleDrive: {
        isConnected: googleDriveState.isConnected,
      },
      settings: getSettingsSnapshot(settings),
      uploadHistory,
    };
    await chrome.storage.session.set({ [STORAGE_KEY_STATE]: popupState });
  } catch {
    // Ignore storage errors.
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

async function syncRuntimeState(): Promise<void> {
  const persistedState = await loadPersistedPopupState();
  sessionArtifacts = await loadPersistedArtifacts();

  sessions = Array.isArray(persistedState?.sessions)
    ? persistedState.sessions.map((session) => ({
        ...session,
        items: cloneProgressItems(session.items || []),
      }))
    : [];

  if (persistedState?.recording) {
    activeRecording.sessionId = persistedState.recording.sessionId ?? null;
    activeRecording.isRecording = Boolean(persistedState.recording.isRecording);
    activeRecording.isPaused = Boolean(persistedState.recording.isPaused);
    activeRecording.tabId = persistedState.recording.tabId ?? null;
    activeRecording.startTime = persistedState.recording.startTime ?? null;
    activeRecording.stopTime = persistedState.recording.stopTime ?? null;
    activeRecording.tabUrl = persistedState.recording.tabUrl ?? null;
  } else {
    resetActiveRecordingState();
  }

  const offscreenState = await probeOffscreenCaptureState();
  const snapshotIds = new Set(offscreenState?.snapshotSessionIds || []);

  if (!offscreenState?.ok || !offscreenState.isRecording) {
    resetActiveRecordingState();
  } else {
    activeRecording.isRecording = Boolean(offscreenState.isRecording);
    activeRecording.isPaused = Boolean(offscreenState.isPaused);
    activeRecording.sessionId = offscreenState.activeSessionId ?? activeRecording.sessionId;
    recorder.hydrateActiveSession(activeRecording.sessionId);
    storage.setPaused(activeRecording.isPaused);
    cdp.setPaused(activeRecording.isPaused);
  }

  sessions = sortSessions(sessions.map((session) => {
    const hasLocalSnapshot = snapshotIds.has(session.id);
    if (session.phase === "uploading") {
      return {
        ...session,
        phase: "failed",
        hasLocalSnapshot,
        error: "Upload was interrupted when the extension runtime restarted.",
      };
    }
    if ((session.phase === "recorded" || session.phase === "failed") && !hasLocalSnapshot) {
      return {
        ...session,
        hasLocalSnapshot: false,
        error: session.error || "Recording snapshot is no longer available for upload.",
      };
    }
    if (session.phase === "uploaded") {
      return {
        ...session,
        hasLocalSnapshot: false,
      };
    }
    return {
      ...session,
      hasLocalSnapshot,
    };
  }));

  await refreshGoogleDriveState();
  await saveArtifactsToStorage();
  await saveStateToStorage();
}

void syncRuntimeState();

chrome.runtime.onStartup.addListener(() => {
  void syncRuntimeState();
});

chrome.runtime.onInstalled.addListener(() => {
  void syncRuntimeState();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "gn-tracing-keepalive" && activeRecording.isRecording) {
    // Intentionally empty: this wakes the service worker during recording.
  }
});

chrome.runtime.onMessage.addListener((message: ServiceWorkerMessage, sender, sendResponse) => {
  if (message.target === "offscreen") {
    return false;
  }

  handleMessage(message, sender).then(sendResponse);
  return true;
});

chrome.runtime.onMessage.addListener((message: any, _sender, sendResponse) => {
  if (message.target !== "offscreen" || message.type !== "UPLOAD_PROGRESS" || !message.data?.sessionId) {
    return false;
  }

  const sessionId = String(message.data.sessionId);
  patchSession(sessionId, {
    phase: "uploading",
    progress: typeof message.data.percent === "number" ? message.data.percent : 0,
    uploadedBytes: typeof message.data.uploadedBytes === "number" ? message.data.uploadedBytes : 0,
    totalBytes: typeof message.data.totalBytes === "number" ? message.data.totalBytes : 0,
    message: typeof message.data.message === "string" ? message.data.message : "Uploading recording...",
    items: Array.isArray(message.data.items) ? message.data.items as ProgressItemSnapshot[] : [],
    error: null,
  });
  void saveStateToStorage();
  sendResponse({ ok: true });
  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (!activeRecording.isRecording || tabId !== activeRecording.tabId) {
    return;
  }

  try {
    await stopRecording();
  } catch {
    resetActiveRecordingState();
    await saveStateToStorage();
  }
});

async function handleMessage(
  message: ServiceWorkerMessage,
  _sender: chrome.runtime.MessageSender,
): Promise<MessageResponse | RecordingStatus | PopupState["sessions"] | null> {
  switch (message.action) {
    case "START_RECORDING":
      return startRecording(message.tabId || 0);
    case "STOP_RECORDING":
      return stopRecording();
    case "PAUSE_RECORDING":
      return pauseRecording();
    case "RESUME_RECORDING":
      return resumeRecording();
    case "GET_STATUS":
      return getRecordingStatus();
    case "GET_SETTINGS":
      return getPopupSettingsResponse();
    case "UPDATE_SETTINGS":
      return updateUploadSettingsFromMessage(message.data);
    case "DELETE_UPLOAD_HISTORY_ENTRY":
      return deleteUploadHistoryEntry(message.data);
    case "DELETE_SESSION":
      return deleteSession(message.data);
    case "UPLOAD_TO_GOOGLE_DRIVE":
      return uploadSessionToGoogleDrive(message.data);
    case "GET_UPLOAD_STATE":
      return sortSessions(sessions);
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
      return { ok: true, token: await googleAuth.getAuthToken() };
    case "RECORDING_COMPLETE":
      recorder.onRecordingComplete(typeof message.data?.sessionId === "string" ? message.data.sessionId : undefined);
      return { ok: true };
    default:
      return { ok: false, error: "Unknown action" };
  }
}

async function startRecording(tabId: number): Promise<MessageResponse> {
  if (activeRecording.isRecording) {
    return { ok: false, error: "Already recording" };
  }

  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url && tab.url.startsWith("chrome://")) {
      return { ok: false, error: "Cannot record chrome:// pages. Please open a regular webpage." };
    }

    const sessionId = createSessionId();
    activeRecording.sessionId = sessionId;
    activeRecording.isRecording = false;
    activeRecording.isPaused = false;
    activeRecording.tabId = tabId;
    activeRecording.startTime = Date.now();
    activeRecording.stopTime = null;
    activeRecording.tabUrl = tab.url ?? null;
    activeRecording.pausedAt = null;
    activeRecording.accumulatedPausedMs = 0;

    storage.beginSession();
    storage.setPaused(false);
    cdp.setPaused(false);

    await Promise.all([
      cdp.attach(tabId),
      recorder.startCapture(tabId, sessionId),
    ]);

    activeRecording.isRecording = true;
    recorder.hydrateActiveSession(sessionId);

    chrome.action.setBadgeText({ text: "REC" });
    chrome.action.setBadgeBackgroundColor({ color: "#ef233c" });
    chrome.alarms.create("gn-tracing-keepalive", { periodInMinutes: 0.4 });

    await saveStateToStorage();
    return { ok: true };
  } catch (error) {
    try {
      await cdp.detach();
    } catch {
      // Ignore detach failures.
    }
    try {
      await recorder.cleanup();
    } catch {
      // Ignore recorder cleanup failures.
    }
    resetActiveRecordingState();
    storage.beginSession();
    await saveStateToStorage();
    return { ok: false, error: (error as Error).message };
  }
}

async function stopRecording(): Promise<MessageResponse> {
  if (!activeRecording.isRecording || !activeRecording.sessionId) {
    return { ok: false, error: "Not recording" };
  }

  const sessionId = activeRecording.sessionId;
  const startTime = activeRecording.startTime;
  const stopTime = Date.now();
  const tabUrl = activeRecording.tabUrl;

  try {
    if (activeRecording.pausedAt) {
      activeRecording.accumulatedPausedMs += Math.max(0, stopTime - activeRecording.pausedAt);
      activeRecording.pausedAt = null;
    }

    activeRecording.isRecording = false;
    activeRecording.isPaused = false;
    activeRecording.stopTime = stopTime;
    storage.setPaused(false);
    cdp.setPaused(false);

    await cdp.flushSourceMaps();
    await Promise.allSettled([
      recorder.stopCapture(),
      cdp.detach(),
    ]);
    storage.resolveSourceMaps(cdp.sourceMapResolver);
    cdp.releaseSourceMaps();

    const finalizedArtifacts = storage.finalizeCurrentSession();
    sessionArtifacts[sessionId] = {
      consoleLogs: finalizedArtifacts.consoleLogs,
      networkRequests: finalizedArtifacts.networkRequests,
      webSocketLogs: finalizedArtifacts.webSocketLogs,
      duration: startTime ? Math.max(0, stopTime - startTime - activeRecording.accumulatedPausedMs) : 0,
      url: tabUrl || "",
      startTime,
      stopTime,
    };

    const sessionSummary: RecordingSessionSummary = {
      id: sessionId,
      phase: "recorded",
      startTime,
      stopTime,
      elapsedMs: sessionArtifacts[sessionId].duration,
      tabUrl,
      consoleLogCount: finalizedArtifacts.consoleLogCount,
      networkRequestCount: finalizedArtifacts.networkRequestCount,
      hasLocalSnapshot: true,
      progress: 0,
      uploadedBytes: 0,
      totalBytes: 0,
      message: "",
      items: [],
      recordingUrl: null,
      recordingFolderId: null,
      indexFileId: null,
      error: null,
    };
    setSession(sessionSummary);

    chrome.action.setBadgeText({ text: "" });
    chrome.alarms.clear("gn-tracing-keepalive");

    resetActiveRecordingState();
    await saveArtifactsToStorage();
    await saveStateToStorage();

    const authToken = await googleAuth.getAuthToken();
    if (authToken) {
      void startSessionUploadTask(sessionId, authToken);
    }

    return { ok: true };
  } catch (error) {
    await saveStateToStorage();
    return { ok: false, error: (error as Error).message };
  }
}

async function pauseRecording(): Promise<MessageResponse> {
  if (!activeRecording.isRecording || activeRecording.isPaused) {
    return { ok: false, error: "Recording is not active" };
  }

  try {
    await recorder.pauseCapture();
    activeRecording.isPaused = true;
    activeRecording.pausedAt = Date.now();
    storage.setPaused(true);
    cdp.setPaused(true);
    await saveStateToStorage();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

async function resumeRecording(): Promise<MessageResponse> {
  if (!activeRecording.isRecording || !activeRecording.isPaused) {
    return { ok: false, error: "Recording is not paused" };
  }

  try {
    await recorder.resumeCapture();
    if (activeRecording.pausedAt) {
      activeRecording.accumulatedPausedMs += Math.max(0, Date.now() - activeRecording.pausedAt);
    }
    activeRecording.isPaused = false;
    activeRecording.pausedAt = null;
    storage.setPaused(false);
    cdp.setPaused(false);
    await saveStateToStorage();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

function normalizeRecordingUrl(recordingUrl: string | null | undefined): string | null {
  if (!recordingUrl) {
    return null;
  }

  try {
    const parsed = new URL(recordingUrl);
    if (parsed.protocol === "chrome-extension:" || parsed.pathname.endsWith("/player/player.html")) {
      const legacyRecordingId = parsed.searchParams.get("id");
      if (legacyRecordingId) {
        return buildExternalPlayerUrl(legacyRecordingId);
      }
    }
    return recordingUrl;
  } catch {
    return recordingUrl;
  }
}

async function getPopupSettingsResponse(): Promise<MessageResponse & {
  settings: UploadSettings;
  uploadHistory: UploadHistoryEntry[];
}> {
  const [settings, uploadHistory] = await Promise.all([
    getUploadSettings(),
    getUploadHistory(),
  ]);

  return {
    ok: true,
    settings: getSettingsSnapshot(settings),
    uploadHistory,
  };
}

async function upsertDriveJsonFile(params: {
  authToken: string;
  filename: string;
  parentFolderId: string | null;
  fileId?: string;
  content: string;
}): Promise<string> {
  const metadata: Record<string, unknown> = {
    name: params.filename,
    mimeType: "application/json",
  };

  if (!params.fileId && params.parentFolderId) {
    metadata.parents = [params.parentFolderId];
  }

  const boundary = `gn-tracing-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const multipartBody =
    `--${boundary}\r\n` +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    "Content-Type: application/json\r\n\r\n" +
    `${params.content}\r\n` +
    `--${boundary}--`;

  const endpoint = params.fileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${params.fileId}?uploadType=multipart&supportsAllDrives=true`
    : "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id&supportsAllDrives=true";
  const method = params.fileId ? "PATCH" : "POST";

  const response = await fetch(endpoint, {
    method,
    headers: {
      Authorization: `Bearer ${params.authToken}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body: multipartBody,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `Drive history sync failed with status ${response.status}`);
  }

  const payload = await response.json().catch(() => ({}));
  return (payload.id as string | undefined) || params.fileId || "";
}

async function syncAllUploadHistoryFiles(
  authToken: string,
  history: UploadHistoryEntry[],
): Promise<void> {
  const fileMap = await getUploadHistoryFileMap();
  const allScopeKeys = new Set<string>([
    ...Object.keys(fileMap),
    ...history.map((entry) => getUploadHistoryScopeKey(entry.targetFolderId)),
  ]);

  for (const scopeKey of allScopeKeys) {
    const scopedHistory = history.filter((entry) => getUploadHistoryScopeKey(entry.targetFolderId) === scopeKey);
    const targetFolderId = scopeKey === "root" ? null : scopeKey;
    const existingFileId = fileMap[scopeKey];
    const historyFileId = await upsertDriveJsonFile({
      authToken,
      filename: UPLOAD_HISTORY_FILENAME,
      parentFolderId: targetFolderId,
      fileId: existingFileId,
      content: JSON.stringify(scopedHistory, null, 2),
    });

    if (historyFileId) {
      fileMap[scopeKey] = historyFileId;
    }
  }

  await saveUploadHistoryFileMap(fileMap);
}

async function persistUploadHistory(session: RecordingSessionSummary, targetFolderId: string | null): Promise<void> {
  if (!session.recordingUrl || !session.recordingFolderId) {
    return;
  }

  const entry: UploadHistoryEntry = {
    id: `${session.recordingFolderId}:${Date.now()}`,
    uploadedAt: Date.now(),
    pageUrl: session.tabUrl || "",
    recordingUrl: session.recordingUrl,
    recordingFolderId: session.recordingFolderId,
    targetFolderId,
    durationMs: session.elapsedMs,
  };

  const history = [entry, ...(await getUploadHistory())].slice(0, MAX_UPLOAD_HISTORY_ITEMS);
  await saveUploadHistory(history);

  const authToken = await googleAuth.getAuthToken();
  if (!authToken) {
    return;
  }

  try {
    await syncAllUploadHistoryFiles(authToken, history);
  } catch (error) {
    console.warn("[Upload History] Failed to sync history JSON to Drive:", error);
  }
}

async function deleteUploadHistoryEntry(
  data: Record<string, unknown> | undefined,
): Promise<MessageResponse> {
  const historyEntryId = typeof data?.historyEntryId === "string" ? data.historyEntryId : "";
  if (!historyEntryId) {
    return { ok: false, error: "Missing history entry id." };
  }

  const previousHistory = await getUploadHistory();
  const nextHistory = previousHistory.filter((entry) => entry.id !== historyEntryId);
  if (nextHistory.length === previousHistory.length) {
    return { ok: false, error: "History item not found." };
  }

  await saveUploadHistory(nextHistory);

  const authToken = await googleAuth.getAuthToken();
  if (authToken) {
    try {
      await syncAllUploadHistoryFiles(authToken, nextHistory);
    } catch (error) {
      console.warn("[Upload History] Failed to sync deletion to Drive:", error);
    }
  }

  await saveStateToStorage();
  return { ok: true };
}

async function deleteSession(data: Record<string, unknown> | undefined): Promise<MessageResponse> {
  const sessionId = typeof data?.sessionId === "string" ? data.sessionId : "";
  if (!sessionId) {
    return { ok: false, error: "Missing session id." };
  }

  if (activeRecording.sessionId === sessionId && activeRecording.isRecording) {
    return { ok: false, error: "Cannot delete an active recording session." };
  }

  const existing = getSession(sessionId);
  if (!existing) {
    return { ok: false, error: "Session not found." };
  }

  sessions = sessions.filter((session) => session.id !== sessionId);
  delete sessionArtifacts[sessionId];

  await saveArtifactsToStorage();
  await saveStateToStorage();

  void chrome.runtime.sendMessage({
    target: "offscreen",
    type: "DELETE_SESSION_SNAPSHOT",
    data: { sessionId },
  }).catch(() => {});

  return { ok: true };
}

async function updateUploadSettingsFromMessage(
  data: Record<string, unknown> | undefined,
): Promise<MessageResponse & { settings?: UploadSettings }> {
  const folderInput = typeof data?.folderInput === "string" ? data.folderInput : "";
  const parsed = parseGoogleDriveFolderInput(folderInput);

  if (parsed.normalizedInput && !parsed.folderId) {
    return {
      ok: false,
      error: "Invalid Google Drive folder input. Use a folder ID or a Google Drive folder link.",
    };
  }

  const settings: UploadSettingsStore = {
    folderInput: parsed.normalizedInput,
    folderId: parsed.folderId,
  };
  await saveUploadSettings(settings);
  await saveStateToStorage();

  return {
    ok: true,
    settings: getSettingsSnapshot(settings),
  };
}

async function uploadSessionToGoogleDrive(
  data: Record<string, unknown> | undefined,
): Promise<MessageResponse> {
  const requestedSessionId = typeof data?.sessionId === "string"
    ? data.sessionId
    : sessions.find((session) => (session.phase === "recorded" || session.phase === "failed") && session.hasLocalSnapshot)?.id;

  if (!requestedSessionId) {
    return { ok: false, error: "No recorded session is available for upload." };
  }

  const authToken = await googleAuth.getAuthToken();
  if (!authToken) {
    return { ok: false, error: "Not connected to Google Drive. Please connect first." };
  }

  if (activeUploadTasks.has(requestedSessionId)) {
    return { ok: true, message: "Upload already in progress." };
  }

  startSessionUploadTask(requestedSessionId, authToken);
  return { ok: true };
}

function startSessionUploadTask(sessionId: string, authToken: string): Promise<void> {
  const existing = activeUploadTasks.get(sessionId);
  if (existing) {
    return existing;
  }

  const task = runSessionUpload(sessionId, authToken)
    .finally(() => {
      activeUploadTasks.delete(sessionId);
    });

  activeUploadTasks.set(sessionId, task);
  return task;
}

async function runSessionUpload(sessionId: string, authToken: string): Promise<void> {
  const session = getSession(sessionId);
  const artifacts = sessionArtifacts[sessionId];

  if (!session || !artifacts || !session.hasLocalSnapshot) {
    patchSession(sessionId, {
      phase: "failed",
      error: "Recording snapshot is no longer available for upload.",
      hasLocalSnapshot: false,
    });
    await saveStateToStorage();
    return;
  }

  const settings = await getUploadSettings();
  patchSession(sessionId, {
    phase: "uploading",
    progress: 0,
    uploadedBytes: 0,
    totalBytes: 0,
    message: "Uploading recording...",
    items: [],
    error: null,
  });
  await saveStateToStorage();

  try {
    const result = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "UPLOAD_TO_GOOGLE_DRIVE",
      data: {
        sessionId,
        consoleLogs: artifacts.consoleLogs,
        networkRequests: artifacts.networkRequests,
        webSocketLogs: artifacts.webSocketLogs,
        duration: artifacts.duration,
        url: artifacts.url,
        startTime: artifacts.startTime,
        authToken,
        targetFolderId: settings.folderId,
      },
    }) as MessageResponse & Partial<UploadSuccessResult>;

    if (!result?.ok) {
      throw new Error(result?.error || "Upload failed");
    }

    const updatedSession = patchSession(sessionId, {
      phase: "uploaded",
      progress: 100,
      uploadedBytes: getSession(sessionId)?.totalBytes || 0,
      totalBytes: getSession(sessionId)?.totalBytes || 0,
      message: "Upload complete!",
      recordingUrl: normalizeRecordingUrl(result.recordingUrl),
      recordingFolderId: typeof result.folderId === "string" ? result.folderId : null,
      indexFileId: typeof result.indexFileId === "string" ? result.indexFileId : null,
      error: null,
      hasLocalSnapshot: false,
    });

    delete sessionArtifacts[sessionId];
    await saveArtifactsToStorage();

    void chrome.runtime.sendMessage({
      target: "offscreen",
      type: "DELETE_SESSION_SNAPSHOT",
      data: { sessionId },
    }).catch(() => {});

    if (updatedSession) {
      await persistUploadHistory(updatedSession, settings.folderId);
    }
  } catch (error) {
    patchSession(sessionId, {
      phase: "failed",
      error: (error as Error).message,
      message: "",
    });
  } finally {
    await saveStateToStorage();
  }
}
