/**
 * Main extension service worker for recording, state, upload, and message routing.
 */
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

/**
 * Service-worker coordinator for the MV3 extension.
 *
 * This file is the durable control plane for recording sessions: it owns popup
 * state persistence, CDP collection, offscreen capture commands, Google Drive
 * auth checks, upload history, and the message contracts that connect those
 * browser surfaces. Keep comments here focused on lifecycle boundaries because
 * MV3 service workers can restart between user actions.
 */
const storage = new StorageManager();
const recorder = new RecorderManager();
const cdp = new CdpManager(storage);
const googleAuth = new GoogleDriveAuth();

void googleAuth.initialize();

interface ActiveRecordingState {
  sessionId: string | null;
  isRecording: boolean;
  tabId: number | null;
  startTime: number | null;
  stopTime: number | null;
  tabUrl: string | null;
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
  activeSessionId?: string | null;
  snapshotSessionIds?: string[];
}

interface UploadSettingsStore {
  folderInput: string;
  folderId: string | null;
  folderPath: string[];
  zipPassword: string;
  captureRequestBodies: boolean;
  captureResponseBodies: boolean;
  captureWebSocketFrames: boolean;
}

interface UploadSuccessResult {
  ok: true;
  recordingUrl?: string;
  folderId?: string;
  indexFileId?: string;
  targetFolderId?: string | null;
}

type UploadArtifactKey = "consoleLogs" | "networkRequests" | "webSocketLogs";

interface UploadArtifactChunkResponse extends MessageResponse {
  chunk?: string;
  nextOffset?: number;
  totalLength?: number;
}

const STORAGE_KEY_STATE = "gn_tracing_state";
const STORAGE_KEY_ARTIFACTS = "gn_tracing_session_artifacts";
const STORAGE_KEY_SETTINGS = "gn_tracing_upload_settings";
const STORAGE_KEY_HISTORY = "gn_tracing_upload_history";
const DEFAULT_UPLOAD_FOLDER_INPUT = "/gn-tracing";
const MAX_UPLOAD_HISTORY_ITEMS = 100;
const UPLOAD_ARTIFACT_CHUNK_CHARS = 1024 * 1024;
const GITHUB_LATEST_RELEASE_URL = "https://api.github.com/repos/gnasdev/gn-tracing/releases/latest";
const DEFAULT_UPLOAD_FOLDER = parseGoogleDriveFolderInput(DEFAULT_UPLOAD_FOLDER_INPUT);

const activeRecording: ActiveRecordingState = {
  sessionId: null,
  isRecording: false,
  tabId: null,
  startTime: null,
  stopTime: null,
  tabUrl: null,
};

let sessions: RecordingSessionSummary[] = [];
let sessionArtifacts: Record<string, SessionArtifacts> = {};
const activeUploadTasks = new Map<string, Promise<void>>();

// Google Drive connectivity is cached separately from popup state so UI reloads
// can show a stable snapshot while a background verification refreshes it.
const googleDriveState = {
  isConnected: false,
  checkedAt: 0,
};

let cachedUploadSettings: UploadSettingsStore = {
  folderInput: DEFAULT_UPLOAD_FOLDER.normalizedInput,
  folderId: DEFAULT_UPLOAD_FOLDER.folderId,
  folderPath: [...DEFAULT_UPLOAD_FOLDER.folderPath],
  zipPassword: "",
  captureRequestBodies: false,
  captureResponseBodies: false,
  captureWebSocketFrames: false,
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
  return Math.max(0, now - activeRecording.startTime);
}

function resetActiveRecordingState(): void {
  activeRecording.sessionId = null;
  activeRecording.isRecording = false;
  activeRecording.tabId = null;
  activeRecording.startTime = null;
  activeRecording.stopTime = null;
  activeRecording.tabUrl = null;
  recorder.clearActiveSession();
}

function sortSessions(items: RecordingSessionSummary[]): RecordingSessionSummary[] {
  return [...items].sort((left, right) => {
    const rightTs = right.stopTime || right.startTime || 0;
    const leftTs = left.stopTime || left.startTime || 0;
    return rightTs - leftTs;
  });
}

function sortUploadHistory(items: UploadHistoryEntry[]): UploadHistoryEntry[] {
  return [...items].sort((left, right) => (right.uploadedAt || 0) - (left.uploadedAt || 0));
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
  const now = Date.now();

  if (!activeRecording.sessionId && !activeRecording.isRecording) {
    return null;
  }

  return {
    phase: activeRecording.isRecording ? "recording" : "idle",
    sessionId: activeRecording.sessionId,
    isRecording: activeRecording.isRecording,
    tabId: activeRecording.tabId,
    startTime: activeRecording.startTime,
    stopTime: activeRecording.stopTime,
    tabUrl: activeRecording.tabUrl,
    elapsedMs: getElapsedMs(now),
    elapsedUpdatedAt: now,
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
    const storedHasFolderInput = typeof stored?.folderInput === "string";
    // Only missing folder settings use the default; saved blank values still mean Drive root.
    const parsedFolder = storedHasFolderInput
      ? parseGoogleDriveFolderInput(stored.folderInput)
      : DEFAULT_UPLOAD_FOLDER;
    cachedUploadSettings = {
      folderInput: parsedFolder.normalizedInput,
      folderId: typeof stored?.folderId === "string" ? stored.folderId : parsedFolder.folderId,
      folderPath: Array.isArray(stored?.folderPath)
        ? stored.folderPath.filter((segment) => typeof segment === "string")
        : [...parsedFolder.folderPath],
      zipPassword: typeof stored?.zipPassword === "string" ? stored.zipPassword : "",
      captureRequestBodies: Boolean(stored?.captureRequestBodies),
      captureResponseBodies: Boolean(stored?.captureResponseBodies),
      captureWebSocketFrames: Boolean(stored?.captureWebSocketFrames),
    };
  } catch {
    cachedUploadSettings = {
      folderInput: DEFAULT_UPLOAD_FOLDER.normalizedInput,
      folderId: DEFAULT_UPLOAD_FOLDER.folderId,
      folderPath: [...DEFAULT_UPLOAD_FOLDER.folderPath],
      zipPassword: "",
      captureRequestBodies: false,
      captureResponseBodies: false,
      captureWebSocketFrames: false,
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
    cachedUploadHistory = Array.isArray(history) ? sortUploadHistory(history as UploadHistoryEntry[]) : [];
  } catch {
    cachedUploadHistory = [];
  }

  hasLoadedUploadHistory = true;
  return cachedUploadHistory;
}

async function saveUploadHistory(history: UploadHistoryEntry[]): Promise<void> {
  cachedUploadHistory = sortUploadHistory(history).slice(0, MAX_UPLOAD_HISTORY_ITEMS);
  hasLoadedUploadHistory = true;
  await chrome.storage.local.set({
    [STORAGE_KEY_HISTORY]: cachedUploadHistory,
  });
}

function getSettingsSnapshot(settings: UploadSettingsStore): UploadSettings {
  return {
    folderInput: settings.folderInput,
    folderId: settings.folderId,
    zipPasswordConfigured: settings.zipPassword.length > 0,
    captureRequestBodies: settings.captureRequestBodies,
    captureResponseBodies: settings.captureResponseBodies,
    captureWebSocketFrames: settings.captureWebSocketFrames,
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

async function buildPopupState(): Promise<PopupState> {
  const [settings, uploadHistory] = await Promise.all([
    getUploadSettings(),
    getUploadHistory(),
  ]);
  return {
    recording: getRecordingStatus(),
    sessions: sortSessions(sessions),
    googleDrive: {
      isConnected: googleDriveState.isConnected,
    },
    settings: getSettingsSnapshot(settings),
    uploadHistory,
  };
}

async function saveStateToStorage(): Promise<PopupState | null> {
  try {
    const popupState = await buildPopupState();
    await chrome.storage.session.set({ [STORAGE_KEY_STATE]: popupState });
    return popupState;
  } catch {
    // Ignore storage errors.
    return null;
  }
}

function notifyPopupStateUpdated(state: PopupState | null): void {
  if (!state) {
    return;
  }
  void chrome.runtime.sendMessage({
    target: "popup",
    action: "POPUP_STATE_UPDATED",
    state,
  }).catch(() => {});
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
    activeRecording.sessionId = offscreenState.activeSessionId ?? activeRecording.sessionId;
    recorder.hydrateActiveSession(activeRecording.sessionId);
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
  if (message.target && message.target !== "service-worker") {
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
): Promise<MessageResponse | UploadArtifactChunkResponse | RecordingStatus | PopupState["sessions"] | null> {
  switch (message.action) {
    case "START_RECORDING":
      return startRecording(message.tabId || 0);
    case "STOP_RECORDING":
      return stopRecording();
    case "REMOVE_RECORDING":
      return removeRecording();
    case "GET_STATUS":
      return getRecordingStatus();
    case "GET_SETTINGS":
      return getPopupSettingsResponse();
    case "UPDATE_SETTINGS":
      return updateUploadSettingsFromMessage(message.data);
    case "CHECK_FOR_UPDATE":
      return checkForExtensionUpdate();
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
    case "GET_UPLOAD_ARTIFACT_CHUNK":
      return getUploadArtifactChunk(message.data);
    default:
      return { ok: false, error: "Unknown action" };
  }
}

async function checkForExtensionUpdate(): Promise<MessageResponse> {
  try {
    const currentVersion = chrome.runtime.getManifest().version;
    const response = await fetch(GITHUB_LATEST_RELEASE_URL, {
      headers: {
        Accept: "application/vnd.github+json",
      },
      cache: "no-store",
    });

    if (!response.ok) {
      return { ok: false, error: `GitHub release check failed (${response.status}).` };
    }

    const latestRelease = await response.json() as {
      tag_name?: unknown;
      name?: unknown;
      html_url?: unknown;
      assets?: Array<{
        name?: unknown;
        browser_download_url?: unknown;
      }>;
    };
    const latestVersion = normalizeReleaseVersion(
      typeof latestRelease.tag_name === "string"
        ? latestRelease.tag_name
        : typeof latestRelease.name === "string"
          ? latestRelease.name
          : "",
    );

    if (!latestVersion) {
      return { ok: false, error: "Latest GitHub release does not include a valid version." };
    }

    const comparison = compareVersions(currentVersion, latestVersion);
    const downloadUrl = getReleaseDownloadUrl(latestRelease);
    const update = {
      currentVersion,
      latestVersion,
      isUpdateAvailable: comparison < 0,
      downloadUrl,
    };
    if (comparison < 0) {
      return { ok: true, message: `New version ${latestVersion} is available. Current ${currentVersion}.`, update };
    }
    if (comparison > 0) {
      return { ok: true, message: `Current ${currentVersion} is newer than GitHub release ${latestVersion}.`, update };
    }
    return { ok: true, message: `GN Tracing is up to date (${currentVersion}).`, update };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

function getReleaseDownloadUrl(release: {
  html_url?: unknown;
  assets?: Array<{
    name?: unknown;
    browser_download_url?: unknown;
  }>;
}): string | undefined {
  const extensionZip = release.assets?.find((asset) => {
    const name = typeof asset.name === "string" ? asset.name : "";
    return /^gn-tracing-extension-.+\.zip$/i.test(name);
  });
  const assetUrl = extensionZip?.browser_download_url;
  if (typeof assetUrl === "string" && assetUrl.trim()) {
    return assetUrl;
  }
  return typeof release.html_url === "string" && release.html_url.trim()
    ? release.html_url
    : undefined;
}

function normalizeReleaseVersion(version: string): string {
  const normalized = version.trim().replace(/^v/i, "");
  return /^\d+(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.-]+)?$/.test(normalized) ? normalized : "";
}

function compareVersions(currentVersion: string, latestVersion: string): number {
  const currentParts = parseVersionParts(currentVersion);
  const latestParts = parseVersionParts(latestVersion);
  for (let index = 0; index < Math.max(currentParts.length, latestParts.length); index += 1) {
    const currentPart = currentParts[index] || 0;
    const latestPart = latestParts[index] || 0;
    if (currentPart !== latestPart) {
      return currentPart > latestPart ? 1 : -1;
    }
  }
  return 0;
}

function parseVersionParts(version: string): number[] {
  return normalizeReleaseVersion(version)
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);
}

function getUploadArtifactChunk(data: Record<string, unknown> | undefined): UploadArtifactChunkResponse {
  const sessionId = typeof data?.sessionId === "string" ? data.sessionId : "";
  const key = typeof data?.key === "string" ? data.key : "";
  const offset = typeof data?.offset === "number" && Number.isFinite(data.offset)
    ? Math.max(0, Math.floor(data.offset))
    : 0;

  if (!sessionId || !isUploadArtifactKey(key)) {
    return { ok: false, error: "Missing upload artifact reference." };
  }

  const value = sessionArtifacts[sessionId]?.[key] || "";
  const totalLength = value.length;
  const chunk = value.slice(offset, offset + UPLOAD_ARTIFACT_CHUNK_CHARS);

  return {
    ok: true,
    chunk,
    nextOffset: offset + chunk.length,
    totalLength,
  };
}

function isUploadArtifactKey(key: string): key is UploadArtifactKey {
  return key === "consoleLogs" || key === "networkRequests" || key === "webSocketLogs";
}

async function startRecording(tabId: number): Promise<MessageResponse> {
  if (activeRecording.isRecording) {
    return { ok: false, error: "Already recording" };
  }

  try {
    const settings = await getUploadSettings();
    const tab = await chrome.tabs.get(tabId);
    if (tab.url && tab.url.startsWith("chrome://")) {
      return { ok: false, error: "Cannot record chrome:// pages. Please open a regular webpage." };
    }

    const sessionId = createSessionId();
    activeRecording.sessionId = sessionId;
    activeRecording.isRecording = false;
    activeRecording.tabId = tabId;
    activeRecording.startTime = Date.now();
    activeRecording.stopTime = null;
    activeRecording.tabUrl = tab.url ?? null;

    storage.beginSession();
    cdp.setCaptureSettings({
      captureRequestBodies: settings.captureRequestBodies,
      captureResponseBodies: settings.captureResponseBodies,
      captureWebSocketFrames: settings.captureWebSocketFrames,
    });

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
    activeRecording.isRecording = false;
    activeRecording.stopTime = stopTime;

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
      duration: startTime ? Math.max(0, stopTime - startTime) : 0,
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

async function removeRecording(): Promise<MessageResponse> {
  if (!activeRecording.isRecording || !activeRecording.sessionId) {
    return { ok: false, error: "No active recording to remove." };
  }

  const sessionId = activeRecording.sessionId;

  try {
    activeRecording.isRecording = false;

    await Promise.allSettled([
      recorder.stopCapture(true),
      cdp.detach(),
    ]);

    storage.clear();
    cdp.releaseSourceMaps();
    delete sessionArtifacts[sessionId];

    chrome.action.setBadgeText({ text: "" });
    chrome.alarms.clear("gn-tracing-keepalive");

    resetActiveRecordingState();
    await saveArtifactsToStorage();
    await saveStateToStorage();

    void chrome.runtime.sendMessage({
      target: "offscreen",
      type: "DELETE_SESSION_SNAPSHOT",
      data: { sessionId },
    }).catch(() => {});

    return { ok: true };
  } catch (error) {
    resetActiveRecordingState();
    storage.clear();
    cdp.releaseSourceMaps();
    await saveArtifactsToStorage();
    await saveStateToStorage();
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

async function persistUploadHistory(session: RecordingSessionSummary, targetFolderId: string | null): Promise<void> {
  if (!session.recordingUrl) {
    return;
  }

  const entry: UploadHistoryEntry = {
    id: `${session.indexFileId || session.recordingUrl}:${Date.now()}`,
    uploadedAt: Date.now(),
    pageUrl: session.tabUrl || "",
    recordingUrl: session.recordingUrl,
    recordingFolderId: session.recordingFolderId,
    targetFolderId,
    durationMs: session.elapsedMs,
  };

  const history = [entry, ...(await getUploadHistory())].slice(0, MAX_UPLOAD_HISTORY_ITEMS);
  await saveUploadHistory(history);
  notifyPopupStateUpdated(await saveStateToStorage());
}

async function deleteUploadHistoryEntry(
  data: Record<string, unknown> | undefined,
): Promise<MessageResponse & { state?: PopupState; uploadHistory?: UploadHistoryEntry[] }> {
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

  const popupState = await saveStateToStorage();
  notifyPopupStateUpdated(popupState);
  return { ok: true, state: popupState || undefined, uploadHistory: nextHistory };
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
  const existingSettings = await getUploadSettings();
  const hasFolderInput = typeof data?.folderInput === "string";
  const hasZipPassword = typeof data?.zipPassword === "string";
  const shouldClearZipPassword = data?.clearZipPassword === true;
  const parsed = hasFolderInput
    ? parseGoogleDriveFolderInput(data.folderInput as string)
    : {
        normalizedInput: existingSettings.folderInput,
        folderId: existingSettings.folderId,
        folderPath: existingSettings.folderPath,
      };

  if (parsed.normalizedInput && !parsed.folderId && parsed.folderPath.length === 0) {
    return {
      ok: false,
      error: "Invalid Google Drive folder input. Use /folder/path, a folder ID, or a Google Drive folder link.",
    };
  }

  const settings: UploadSettingsStore = {
    folderInput: parsed.normalizedInput,
    folderId: parsed.folderId,
    folderPath: parsed.folderPath,
    // Keep plaintext password out of popup snapshots; it is only read here for uploads.
    zipPassword: shouldClearZipPassword
      ? ""
      : hasZipPassword
        ? (data.zipPassword as string)
        : existingSettings.zipPassword,
    captureRequestBodies: typeof data?.captureRequestBodies === "boolean"
      ? data.captureRequestBodies
      : existingSettings.captureRequestBodies,
    captureResponseBodies: typeof data?.captureResponseBodies === "boolean"
      ? data.captureResponseBodies
      : existingSettings.captureResponseBodies,
    captureWebSocketFrames: typeof data?.captureWebSocketFrames === "boolean"
      ? data.captureWebSocketFrames
      : existingSettings.captureWebSocketFrames,
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
        artifactKeys: {
          consoleLogs: Boolean(artifacts.consoleLogs),
          networkRequests: Boolean(artifacts.networkRequests),
          webSocketLogs: Boolean(artifacts.webSocketLogs),
        },
        duration: artifacts.duration,
        url: artifacts.url,
        startTime: artifacts.startTime,
        authToken,
        targetFolderId: settings.folderId,
        targetFolderPath: settings.folderPath,
        zipPassword: settings.zipPassword || null,
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
      await persistUploadHistory(
        updatedSession,
        typeof result.targetFolderId === "string" ? result.targetFolderId : settings.folderId,
      );
    }
  } catch (error) {
    patchSession(sessionId, {
      phase: "failed",
      error: (error as Error).message,
      message: "",
    });
  } finally {
    notifyPopupStateUpdated(await saveStateToStorage());
  }
}
