/**
 * Main extension service worker for recording, state, upload, and message routing.
 */

import { DEFAULT_DRAW_COLOR, normalizeDrawColor } from "../shared/drawing";
import {
  buildRecordingPrivacySummary,
  getPrivacyProfileSettings,
  normalizeMaskDomSelectors,
  REDACTED_VALUE,
  redactBodyText,
  redactHeaderMap,
  redactJsonValue,
  redactReport,
  redactUrl,
  redactUserEvent,
} from "../shared/privacy-redaction";
import { getRecordingTabTarget } from "../shared/recording-target";
import { normalizeStorageProviderId, type StorageProviderId } from "../shared/storage-provider";
import type {
  CaptureMode,
  CaptureProfile,
  ConsolePreviewDepth,
  ConsoleSourceSnippetMode,
  ConsoleStackMode,
  HeaderCaptureMode,
  InitiatorCaptureMode,
  MessageResponse,
  PopupState,
  PrivacyProfile,
  PrivacyRedactionSettings,
  ProgressItemSnapshot,
  RecordingSessionSummary,
  RecordingStatus,
  RedirectHeaderCaptureMode,
  ResponseBodyCaptureMode,
  UploadHistoryEntry,
  UploadSettings,
} from "../types/messages";
import type {
  CaptureEnvironment,
  ConsoleEntry,
  CookieRecord,
  NetworkEntry,
  RecordingDrawingArtifact,
  RecordingDrawStroke,
  RecordingPrivacySummary,
  RecordingReport,
  RecordingUserEvent,
  RecordingUserEventArtifact,
  RedactionHit,
  SourceMapDiagnosticsArtifact,
  StorageKeyValue,
  StorageSnapshot,
  WebSocketEntry,
} from "../types/recording";
import {
  buildFallbackEnvironment,
  normalizeCaptureEnvironment,
  normalizeFiniteNumber,
  normalizeRecordingUserEvent,
  truncateEventString,
} from "./capture-environment";
import { CdpManager } from "./cdp-manager";
import { submitFeedback } from "./feedback-submit";
import { registerMessageListeners } from "./message-router";
import { RecorderManager } from "./recorder-manager";
import type { ProviderFolderSettings, UploadSettingsStore } from "./settings-store";
import {
  DEFAULT_PRIVACY_REDACTION_SETTINGS,
  getCaptureProfileSettings,
  getSettingsSnapshot,
  getUploadHistory,
  getUploadSettings,
  loadPersistedPopupState,
  MAX_UPLOAD_HISTORY_ITEMS,
  normalizeBoolean,
  normalizeEnum,
  normalizeOptionalNumber,
  normalizeRecordingUrl,
  parseFolderInputForProvider,
  pickPrivacyRedactionSettings,
  STORAGE_KEY_STATE,
  saveUploadHistory,
  saveUploadSettings,
} from "./settings-store";
import {
  getDropboxProvider,
  getGoogleDriveProvider,
  requireRegisteredStorageProvider,
  resolveRegisteredUploadProviderId,
  type StorageProvider,
} from "./storage";
import { StorageManager } from "./storage-manager";
import type { UploadSuccessResult } from "./upload-orchestrator";
import { getUploadArtifactChunk } from "./upload-orchestrator";

/**
 * Service-worker coordinator for the MV3 extension.
 *
 * This file is the durable control plane for recording sessions: it owns popup
 * state persistence, CDP collection, offscreen capture commands, storage
 * provider auth checks, upload history, and the message contracts that connect
 * those browser surfaces. Keep comments here focused on lifecycle boundaries
 * because MV3 service workers can restart between user actions.
 */
const storage = new StorageManager();
const recorder = new RecorderManager();
const cdp = new CdpManager(storage);
/** Multi-cloud storage providers from the registry (Drive + Dropbox). */
const googleDriveProvider = getGoogleDriveProvider();
const googleAuth = googleDriveProvider.getAuth();
const dropboxProvider = getDropboxProvider();
const dropboxAuth = dropboxProvider.getAuth();

void googleAuth.initialize();

interface ActiveRecordingState {
  sessionId: string | null;
  isRecording: boolean;
  tabId: number | null;
  startTime: number | null;
  stopTime: number | null;
  tabUrl: string | null;
  tabTitle: string | null;
  environment: CaptureEnvironment | null;
  userEvents: RecordingUserEvent[];
  drawingStrokes: RecordingDrawStroke[];
  drawingClears: number[];
  drawingOverlayActive: boolean;
  redactionHits: RedactionHit[];
  privacyLimitations: string[];
  privacySettings: PrivacyRedactionSettings;
  recordingSettings: UploadSettingsStore | null;
}

export interface SessionArtifacts {
  consoleLogs?: string;
  networkRequests?: string;
  webSocketLogs?: string;
  report?: string;
  userEvents?: string;
  drawing?: string;
  privacy?: string;
  diagnostics?: string;
  storage?: string;
  dom?: string;
  screenshotDataUrl?: string;
  duration: number;
  url: string;
  startTime: number | null;
  stopTime: number | null;
}

interface OffscreenCaptureState {
  ok: boolean;
  isRecording?: boolean;
  activeSessionId?: string | null;
  snapshotSessionIds?: string[];
}

const STORAGE_KEY_ARTIFACTS = "gn_tracing_session_artifacts";
const STORAGE_KEY_DRAWING_COLOR = "gn_tracing_drawing_color";
const MAX_RECORDED_USER_EVENTS = 2000;
const MAX_DRAWING_STROKES = 2000;
const MAX_DRAWING_POINTS_PER_STROKE = 500;
const MAX_TOTAL_DRAWING_POINTS = 100_000;
const MAX_DRAWING_CLEARS = 100;
const MAX_SCREENSHOT_DATA_URL_CHARS = 1536 * 1024;
const RECORDING_EVENTS_SCRIPT = "content/recording-events.js";
const DRAWING_OVERLAY_SCRIPT = "content/drawing-overlay.js";
// In-page capture (captureMode === "in-page") content scripts. The relay runs in
// the ISOLATED world (it needs `chrome.runtime`), while the capture script runs
// in the page's MAIN world so it can see the real console/fetch/XHR/WebSocket.
const IN_PAGE_RELAY_SCRIPT = "content/in-page-relay.js";
const IN_PAGE_CAPTURE_SCRIPT = "content/in-page-capture.js";
// After STOP, give the MAIN→relay→service-worker bridge a brief window to deliver
// any in-flight entries (notably the final "stop" storage snapshot) before the
// session is finalized into artifacts.
const IN_PAGE_DRAIN_DELAY_MS = 200;

const activeRecording: ActiveRecordingState = {
  sessionId: null,
  isRecording: false,
  tabId: null,
  startTime: null,
  stopTime: null,
  tabUrl: null,
  tabTitle: null,
  environment: null,
  userEvents: [],
  drawingStrokes: [],
  drawingClears: [],
  drawingOverlayActive: false,
  redactionHits: [],
  privacyLimitations: [],
  privacySettings: DEFAULT_PRIVACY_REDACTION_SETTINGS,
  recordingSettings: null,
};

/** Pen color for the active drawing overlay; survives popup close within the worker. */
let drawingColor = DEFAULT_DRAW_COLOR;

let sessions: RecordingSessionSummary[] = [];
let sessionArtifacts: Record<string, SessionArtifacts> = {};
const activeUploadTasks = new Map<string, Promise<void>>();

// Provider connectivity is cached separately from popup state so UI reloads
// can show a stable snapshot while a background verification refreshes it.
const googleDriveState = {
  isConnected: false,
  checkedAt: 0,
};
const dropboxState = {
  isConnected: false,
  checkedAt: 0,
};

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
  activeRecording.tabTitle = null;
  activeRecording.environment = null;
  activeRecording.userEvents = [];
  activeRecording.drawingStrokes = [];
  activeRecording.drawingClears = [];
  activeRecording.drawingOverlayActive = false;
  activeRecording.redactionHits = [];
  activeRecording.privacyLimitations = [];
  activeRecording.privacySettings = DEFAULT_PRIVACY_REDACTION_SETTINGS;
  activeRecording.recordingSettings = null;
  recorder.clearActiveSession();
}

function recordActiveRedactionHits(hits: RedactionHit[] | undefined): void {
  if (!hits?.length || !activeRecording.sessionId) {
    return;
  }
  activeRecording.redactionHits.push(...hits);
  if (activeRecording.redactionHits.length > 10000) {
    activeRecording.redactionHits.splice(0, activeRecording.redactionHits.length - 10000);
  }
}

function addActivePrivacyLimitation(message: string): void {
  if (!message || activeRecording.privacyLimitations.includes(message)) {
    return;
  }
  activeRecording.privacyLimitations.push(message);
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

function patchSession(
  sessionId: string,
  patch: Partial<RecordingSessionSummary>,
): RecordingSessionSummary | null {
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

async function refreshDropboxState(): Promise<void> {
  const status = await dropboxAuth.getStatus();
  dropboxState.isConnected = status.isConnected;
  dropboxState.checkedAt = Date.now();
}

async function refreshStorageProviderState(providerId: StorageProviderId): Promise<boolean> {
  if (providerId === "google-drive") {
    await refreshGoogleDriveState();
    return googleDriveState.isConnected;
  }
  if (providerId === "dropbox") {
    await refreshDropboxState();
    return dropboxState.isConnected;
  }
  return false;
}

function getCachedStorageConnected(providerId: StorageProviderId): boolean {
  if (providerId === "google-drive") {
    return googleDriveState.isConnected;
  }
  if (providerId === "dropbox") {
    return dropboxState.isConnected;
  }
  return false;
}

function mirroredConnectedKeyForProvider(provider: StorageProviderId): string {
  if (provider === "dropbox") return "gn_tracing_dropbox_connected";
  return "gn_tracing_google_drive_connected";
}

/**
 * Reads the persisted connection mirror for the active storage provider from
 * `chrome.storage.local` so popup surfaces can paint the correct auth UI before
 * the service worker finishes re-hydrating after a browser or extension restart.
 */
async function loadMirroredStorageConnectionState(): Promise<{
  provider: StorageProviderId;
  isConnected: boolean | null;
}> {
  try {
    const settings = await getUploadSettings();
    const provider = settings.activeStorageProvider;
    const key = mirroredConnectedKeyForProvider(provider);
    const result = await chrome.storage.local.get(key);
    const value = result[key];
    return {
      provider,
      isConnected: typeof value === "boolean" ? value : null,
    };
  } catch {
    return { provider: "google-drive", isConnected: null };
  }
}

/** @deprecated Prefer loadMirroredStorageConnectionState */
async function loadMirroredGoogleDriveState(): Promise<boolean | null> {
  try {
    const result = await chrome.storage.local.get("gn_tracing_google_drive_connected");
    const value = result.gn_tracing_google_drive_connected;
    return typeof value === "boolean" ? value : null;
  } catch {
    return null;
  }
}

async function buildPopupState(): Promise<PopupState> {
  const [settings, uploadHistory] = await Promise.all([getUploadSettings(), getUploadHistory()]);
  const activeProvider = settings.activeStorageProvider;
  const storageConnected = getCachedStorageConnected(activeProvider);
  return {
    recording: getRecordingStatus(),
    sessions: sortSessions(sessions),
    storage: {
      provider: activeProvider,
      isConnected: storageConnected,
    },
    // Shim: existing popup/drive-auth UI still reads googleDrive.isConnected.
    // Prefer `storage` for the active provider; googleDrive always mirrors Drive.
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
  void chrome.runtime
    .sendMessage({
      target: "popup",
      action: "POPUP_STATE_UPDATED",
      state,
    })
    .catch(() => {});
}

async function probeOffscreenCaptureState(): Promise<OffscreenCaptureState | null> {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    });

    if (contexts.length === 0) {
      return null;
    }

    return (await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "GET_CAPTURE_STATE",
    })) as OffscreenCaptureState;
  } catch {
    return null;
  }
}

async function closeOffscreenDocumentIfIdle(): Promise<void> {
  if (activeUploadTasks.size > 1) {
    return;
  }

  const offscreenState = await probeOffscreenCaptureState();
  if (
    !offscreenState?.ok ||
    offscreenState.isRecording ||
    (offscreenState.snapshotSessionIds || []).length > 0
  ) {
    return;
  }

  await recorder.closeOffscreenDocument();
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
    activeRecording.tabTitle = null;
    activeRecording.environment = buildFallbackEnvironment();
    activeRecording.userEvents = [];
    activeRecording.redactionHits = [];
    activeRecording.privacyLimitations = [];
    activeRecording.privacySettings = DEFAULT_PRIVACY_REDACTION_SETTINGS;
    activeRecording.recordingSettings = null;
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

  sessions = sortSessions(
    sessions.map((session) => {
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
    }),
  );

  // Seed connection caches from local mirrors before network refresh so popup
  // first-paint for the active provider is correct for Drive and Dropbox.
  try {
    const driveMirror = await chrome.storage.local.get("gn_tracing_google_drive_connected");
    if (typeof driveMirror.gn_tracing_google_drive_connected === "boolean") {
      googleDriveState.isConnected = driveMirror.gn_tracing_google_drive_connected;
    }
    const dropboxMirror = await chrome.storage.local.get("gn_tracing_dropbox_connected");
    if (typeof dropboxMirror.gn_tracing_dropbox_connected === "boolean") {
      dropboxState.isConnected = dropboxMirror.gn_tracing_dropbox_connected;
    }
  } catch {
    // ignore mirror read failures
  }
  // Prefer active-provider mirror when available.
  const activeMirror = await loadMirroredStorageConnectionState();
  if (activeMirror.isConnected !== null) {
    if (activeMirror.provider === "dropbox") {
      dropboxState.isConnected = activeMirror.isConnected;
    } else if (activeMirror.provider === "google-drive") {
      googleDriveState.isConnected = activeMirror.isConnected;
    }
  }
  await refreshGoogleDriveState();
  await refreshDropboxState().catch(() => {
    // Dropbox optional when client id unset; ignore refresh failures.
  });
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

function patchUploadProgress(sessionId: string, data: Record<string, unknown>): void {
  patchSession(sessionId, {
    phase: "uploading",
    progress: typeof data.percent === "number" ? data.percent : 0,
    uploadedBytes: typeof data.uploadedBytes === "number" ? data.uploadedBytes : 0,
    totalBytes: typeof data.totalBytes === "number" ? data.totalBytes : 0,
    message: typeof data.message === "string" ? data.message : "Uploading recording...",
    items: Array.isArray(data.items) ? (data.items as ProgressItemSnapshot[]) : [],
    error: null,
  });
  void saveStateToStorage();
}

registerMessageListeners({
  startRecording,
  stopRecording,
  removeRecording,
  getRecordingStatus,
  getPopupSettingsResponse,
  updateUploadSettingsFromMessage,
  deleteUploadHistoryEntry,
  deleteSession,
  handleRecordingUserEvent,
  handleRecordingDrawStroke,
  handleRecordingDrawClear,
  toggleDrawingOverlay,
  getDrawingOverlayState,
  setDrawingColor,
  handleRecordingInPageEntry,
  uploadSessionToGoogleDrive,
  getUploadState: () => sortSessions(sessions),
  storageConnect: async (data) => {
    const resolved = await resolveStorageProviderFromMessage(data);
    if (!resolved.ok) {
      return resolved;
    }
    const { provider } = resolved;
    const result = await provider.connect();
    if (result.ok) {
      await refreshStorageProviderState(provider.id);
      await saveStateToStorage();
    }
    return result;
  },
  storageDisconnect: async (data) => {
    const resolved = await resolveStorageProviderFromMessage(data);
    if (!resolved.ok) {
      return resolved;
    }
    const { provider } = resolved;
    // Always return the provider disconnect result (do not discard it).
    const result = await provider.disconnect();
    await refreshStorageProviderState(provider.id);
    await saveStateToStorage();
    return result;
  },
  storageStatus: async (data) => {
    const resolved = await resolveStorageProviderFromMessage(data);
    if (!resolved.ok) {
      return resolved;
    }
    const { provider } = resolved;
    const isConnected = await provider.isConnected();
    if (provider.id === "google-drive") {
      googleDriveState.isConnected = isConnected;
      googleDriveState.checkedAt = Date.now();
    } else if (provider.id === "dropbox") {
      dropboxState.isConnected = isConnected;
      dropboxState.checkedAt = Date.now();
    }
    await saveStateToStorage();
    return { ok: true, isConnected };
  },
  getStorageToken: async (data) => {
    const resolved = await resolveStorageProviderFromMessage(data);
    if (!resolved.ok) {
      return { ok: false, token: null, error: resolved.error };
    }
    return { ok: true, token: await resolved.provider.getAuthToken() };
  },
  onRecordingComplete: (sessionId) => {
    recorder.onRecordingComplete(sessionId);
  },
  getUploadArtifactChunk: (data) => getUploadArtifactChunk(sessionArtifacts, data),
  patchUploadProgress,
  submitFeedback,
});

/**
 * Resolves which StorageProvider handles a message. Explicit `data.provider`
 * wins; otherwise the active setting. Unregistered providers fail closed via
 * requireRegisteredStorageProvider.
 */
async function resolveStorageProviderFromMessage(
  data?: Record<string, unknown>,
): Promise<{ ok: true; provider: StorageProvider } | { ok: false; error: string }> {
  let requested: unknown;
  if (data && "provider" in data) {
    requested = data.provider;
  } else {
    const settings = await getUploadSettings();
    requested = settings.activeStorageProvider;
  }
  return requireRegisteredStorageProvider(requested);
}

function providerDisplayName(providerId: StorageProviderId): string {
  if (providerId === "dropbox") return "Dropbox";
  return "Google Drive";
}

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

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (
    !activeRecording.isRecording ||
    tabId !== activeRecording.tabId ||
    !activeRecording.sessionId
  ) {
    return;
  }

  if (typeof tab.url === "string") {
    activeRecording.tabUrl = tab.url;
  }
  if (typeof tab.title === "string") {
    activeRecording.tabTitle = tab.title;
  }

  if (changeInfo.status === "complete") {
    // Page navigations replace the injected listener context, so re-arm it on
    // complete while keeping the recording alive.
    void startRecordingEventCapture(tabId, activeRecording.sessionId);
    void startDrawingOverlay(tabId, activeRecording.sessionId);
    if (activeRecording.recordingSettings?.captureMode === "in-page") {
      // Re-inject the in-page capture pair after navigation tears down the
      // previous MAIN-world instrumentation.
      void startInPageCapture(tabId, activeRecording.sessionId);
    }
  }
});

function buildDefaultReportTitle(tabTitle: string | null, tabUrl: string | null): string {
  const normalizedTitle = truncateEventString(tabTitle, 120);
  if (normalizedTitle) {
    return normalizedTitle;
  }

  if (!tabUrl) {
    return "Recorded browser session";
  }

  try {
    const parsed = new URL(tabUrl);
    const path = parsed.pathname.split("/").filter(Boolean).pop();
    return (
      [parsed.hostname.replace(/^www\./, ""), path].filter(Boolean).join(" / ") || parsed.hostname
    );
  } catch {
    return truncateEventString(tabUrl, 120) || "Recorded browser session";
  }
}

function buildRecordingReport(stopTime: number): RecordingReport {
  const environment = activeRecording.environment || buildFallbackEnvironment();
  const pageUrl = activeRecording.tabUrl || "";
  const pageTitle = truncateEventString(activeRecording.tabTitle, 160);

  const report: RecordingReport = {
    schemaVersion: 1,
    title: buildDefaultReportTitle(pageTitle || null, pageUrl),
    source: "extension",
    createdAt: new Date(stopTime).toISOString(),
    page: {
      url: pageUrl,
      ...(pageTitle ? { title: pageTitle } : {}),
    },
    environment,
  };
  const redacted = redactReport(report, activeRecording.privacySettings);
  recordActiveRedactionHits(redacted.applied);
  return redacted.value;
}

function buildUserEventArtifact(events: RecordingUserEvent[]): RecordingUserEventArtifact | null {
  if (events.length === 0) {
    return null;
  }

  return {
    schemaVersion: 1,
    events,
  };
}

function buildSourceMapDiagnosticsArtifact(stopTime: number): SourceMapDiagnosticsArtifact | null {
  const sourceMaps = cdp.getSourceMapDiagnostics();
  if (sourceMaps.length === 0) {
    return null;
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date(stopTime).toISOString(),
    sourceMaps,
  };
}

async function startRecordingEventCapture(
  tabId: number,
  sessionId: string,
  privacySettings: PrivacyRedactionSettings = activeRecording.privacySettings,
): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [RECORDING_EVENTS_SCRIPT],
    });
    await chrome.tabs.sendMessage(tabId, {
      target: "recording-events",
      type: "START",
      sessionId,
      privacySettings: pickPrivacyRedactionSettings(privacySettings),
    });
  } catch (error) {
    if (privacySettings.maskDomSelectors.length > 0) {
      addActivePrivacyLimitation("Visual masking could not be injected into the recorded tab.");
    }
    console.warn("[GN Tracing] User-event capture unavailable:", error);
  }
}

async function stopRecordingEventCapture(tabId: number | null): Promise<void> {
  if (tabId == null) {
    return;
  }

  await chrome.tabs
    .sendMessage(tabId, {
      target: "recording-events",
      type: "STOP",
    })
    .catch(() => {});
}

async function loadDrawingColorPreference(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY_DRAWING_COLOR);
    const color = normalizeDrawColor(stored[STORAGE_KEY_DRAWING_COLOR]);
    if (color) {
      drawingColor = color;
    }
  } catch {
    // Keep default when storage is unavailable.
  }
}

const drawingColorReady = loadDrawingColorPreference();

async function persistDrawingColorPreference(color: string): Promise<void> {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY_DRAWING_COLOR]: color });
  } catch {
    // Preference is best-effort.
  }
}

async function applyDrawingColorToOverlay(tabId: number, color: string): Promise<void> {
  await chrome.tabs
    .sendMessage(tabId, {
      target: "drawing-overlay",
      type: "SET_COLOR",
      color,
    })
    .catch(() => {});
}

async function startDrawingOverlay(tabId: number, sessionId: string): Promise<void> {
  try {
    await drawingColorReady;
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [DRAWING_OVERLAY_SCRIPT],
    });
    await chrome.tabs.sendMessage(tabId, {
      target: "drawing-overlay",
      type: "START",
      sessionId,
      color: drawingColor,
    });
    await applyDrawingColorToOverlay(tabId, drawingColor);
    activeRecording.drawingOverlayActive = false;
  } catch (error) {
    console.warn("[GN Tracing] Drawing overlay injection unavailable:", error);
  }
}

async function stopDrawingOverlay(tabId: number | null): Promise<void> {
  if (tabId == null) {
    return;
  }
  await chrome.tabs
    .sendMessage(tabId, {
      target: "drawing-overlay",
      type: "STOP",
    })
    .catch(() => {});
}

async function toggleDrawingOverlay(): Promise<MessageResponse> {
  if (!activeRecording.isRecording || !activeRecording.sessionId || activeRecording.tabId == null) {
    return { ok: false, error: "No active recording." };
  }

  try {
    const response = (await chrome.tabs.sendMessage(activeRecording.tabId, {
      target: "drawing-overlay",
      type: "TOGGLE",
    })) as { active?: boolean };
    activeRecording.drawingOverlayActive = Boolean(response?.active);
    return { ok: true, active: activeRecording.drawingOverlayActive } as MessageResponse;
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

async function getDrawingOverlayState(): Promise<
  MessageResponse & { active?: boolean; color?: string }
> {
  await drawingColorReady;
  if (!activeRecording.isRecording || activeRecording.tabId == null) {
    return { ok: true, active: false, color: drawingColor };
  }

  try {
    const response = (await chrome.tabs.sendMessage(activeRecording.tabId, {
      target: "drawing-overlay",
      type: "GET_STATE",
    })) as { active?: boolean };
    activeRecording.drawingOverlayActive = Boolean(response?.active);
    return {
      ok: true,
      active: activeRecording.drawingOverlayActive,
      color: drawingColor,
    };
  } catch (error) {
    return { ok: false, error: (error as Error).message, color: drawingColor };
  }
}

async function setDrawingColor(
  data?: Record<string, unknown>,
): Promise<MessageResponse & { color?: string }> {
  await drawingColorReady;
  const color = normalizeDrawColor(data?.color);
  if (!color) {
    return { ok: false, error: "Invalid drawing color. Use a CSS hex value such as #ff6b6b." };
  }

  drawingColor = color;
  void persistDrawingColorPreference(color);

  if (activeRecording.isRecording && activeRecording.tabId != null) {
    await applyDrawingColorToOverlay(activeRecording.tabId, color);
  }

  return { ok: true, color };
}

function normalizeDrawingStroke(value: unknown): RecordingDrawStroke | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.strokeId !== "string" || !raw.strokeId) {
    return null;
  }
  const timestamp = normalizeFiniteNumber(raw.timestamp);
  if (!timestamp) {
    return null;
  }
  const color = normalizeDrawColor(raw.color) || DEFAULT_DRAW_COLOR;
  const width = normalizeFiniteNumber(raw.width) ?? 3;
  if (!Array.isArray(raw.points)) {
    return null;
  }
  const points: RecordingDrawStroke["points"] = [];
  for (const point of raw.points) {
    if (!point || typeof point !== "object") {
      continue;
    }
    const p = point as Record<string, unknown>;
    const x = normalizeFiniteNumber(p.x);
    const y = normalizeFiniteNumber(p.y);
    const t = normalizeFiniteNumber(p.t);
    if (x == null || y == null || t == null) {
      continue;
    }
    points.push({ x, y, t });
  }
  if (points.length === 0) {
    return null;
  }
  return {
    strokeId: raw.strokeId,
    timestamp,
    color,
    width,
    points: points.slice(0, MAX_DRAWING_POINTS_PER_STROKE),
  };
}

function handleRecordingDrawStroke(
  data: Record<string, unknown> | undefined,
  sender: chrome.runtime.MessageSender,
): MessageResponse {
  const sessionId = typeof data?.sessionId === "string" ? data.sessionId : "";
  if (
    !sessionId ||
    sessionId !== activeRecording.sessionId ||
    sender.tab?.id !== activeRecording.tabId ||
    !activeRecording.isRecording
  ) {
    return { ok: true };
  }

  const stroke = normalizeDrawingStroke(data?.stroke);
  if (!stroke) {
    return { ok: true };
  }

  activeRecording.drawingStrokes.push(stroke);
  if (activeRecording.drawingStrokes.length > MAX_DRAWING_STROKES) {
    activeRecording.drawingStrokes.splice(
      0,
      activeRecording.drawingStrokes.length - MAX_DRAWING_STROKES,
    );
  }

  const totalPoints = activeRecording.drawingStrokes.reduce((sum, s) => sum + s.points.length, 0);
  if (totalPoints > MAX_TOTAL_DRAWING_POINTS) {
    addActivePrivacyLimitation(
      "Drawing capture reached the point budget; older strokes were dropped.",
    );
    while (
      activeRecording.drawingStrokes.length > 1 &&
      activeRecording.drawingStrokes.reduce((sum, s) => sum + s.points.length, 0) >
        MAX_TOTAL_DRAWING_POINTS
    ) {
      activeRecording.drawingStrokes.shift();
    }
  }

  return { ok: true };
}

function handleRecordingDrawClear(
  data: Record<string, unknown> | undefined,
  sender: chrome.runtime.MessageSender,
): MessageResponse {
  const sessionId = typeof data?.sessionId === "string" ? data.sessionId : "";
  if (
    !sessionId ||
    sessionId !== activeRecording.sessionId ||
    sender.tab?.id !== activeRecording.tabId ||
    !activeRecording.isRecording
  ) {
    return { ok: true };
  }

  const timestamp = normalizeFiniteNumber(data?.timestamp);
  if (!timestamp) {
    return { ok: true };
  }

  activeRecording.drawingClears.push(timestamp);
  if (activeRecording.drawingClears.length > MAX_DRAWING_CLEARS) {
    activeRecording.drawingClears.splice(
      0,
      activeRecording.drawingClears.length - MAX_DRAWING_CLEARS,
    );
  }

  return { ok: true };
}

function buildDrawingArtifact(
  strokes: RecordingDrawStroke[],
  clears: number[],
): string | undefined {
  if (strokes.length === 0 && clears.length === 0) {
    return undefined;
  }
  const artifact: RecordingDrawingArtifact = { schemaVersion: 1, strokes };
  if (clears.length > 0) {
    artifact.clears = clears;
  }
  return JSON.stringify(artifact);
}

/**
 * Injects the in-page capture pair for `captureMode === "in-page"` and starts it.
 *
 * The ISOLATED-world relay is injected first (it bridges `chrome.runtime` to the
 * page via `window.postMessage`), then the MAIN-world capture script. MAIN-world
 * injection can be rejected when the page's Content Security Policy forbids it
 * (R9.6): when that happens we record a limitation that suggests switching to
 * `captureMode: "cdp"` and keep the recording alive with reduced fidelity rather
 * than aborting. Returns `true` when MAIN-world capture is active.
 */
async function startInPageCapture(tabId: number, sessionId: string): Promise<boolean> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [IN_PAGE_RELAY_SCRIPT],
    });
  } catch (error) {
    addActivePrivacyLimitation(
      'In-page capture could not be installed in the recorded tab. Switch captureMode to "cdp" for full-fidelity capture.',
    );
    console.warn("[GN Tracing] In-page relay injection unavailable:", error);
    return false;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [IN_PAGE_CAPTURE_SCRIPT],
      world: "MAIN",
    });
  } catch (error) {
    // A strict page CSP can block MAIN-world script injection (R9.6).
    addActivePrivacyLimitation(
      'In-page capture was blocked by the page Content Security Policy, so console/network/storage were not captured. Switch captureMode to "cdp" for full-fidelity capture.',
    );
    console.warn("[GN Tracing] In-page MAIN-world injection blocked by CSP:", error);
    return false;
  }

  // The relay (ISOLATED) forwards this control message to the MAIN-world script.
  await chrome.tabs
    .sendMessage(tabId, {
      target: "in-page-capture",
      type: "START",
      sessionId,
    })
    .catch(() => {});
  return true;
}

/**
 * Signals the in-page capture to stop. The MAIN-world cleanup restores every
 * monkey-patched global (R9.4) and emits the final "stop" storage snapshot over
 * the bridge before tearing down.
 */
async function stopInPageCapture(tabId: number | null, sessionId: string): Promise<void> {
  if (tabId == null) {
    return;
  }
  await chrome.tabs
    .sendMessage(tabId, {
      target: "in-page-capture",
      type: "STOP",
      sessionId,
    })
    .catch(() => {});
}

function waitForInPageDrain(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, IN_PAGE_DRAIN_DELAY_MS);
  });
}

/**
 * Redacts an in-page-captured `NetworkEntry` before buffering, mirroring the
 * service-worker-side redaction the CDP path applies at capture time (URL,
 * request/response headers, and request body fields). In-page mode never reads
 * response bodies (R9.5), so there is nothing further to redact there.
 */
function redactInPageNetworkEntry(entry: NetworkEntry): NetworkEntry {
  const settings = activeRecording.privacySettings;

  const urlResult = redactUrl(entry.url, settings, "url", "network.request.url");
  recordActiveRedactionHits(urlResult.applied);
  entry.url = urlResult.value || entry.url;

  if (entry.requestHeaders) {
    const headers = redactHeaderMap(entry.requestHeaders, settings, "headers");
    recordActiveRedactionHits(headers.applied);
    entry.requestHeaders = headers.value;
  }
  if (entry.responseHeaders) {
    const headers = redactHeaderMap(entry.responseHeaders, settings, "headers");
    recordActiveRedactionHits(headers.applied);
    entry.responseHeaders = headers.value;
  }
  if (entry.postData != null && settings.redactRequestBodyFields) {
    const body = redactBodyText(
      entry.postData,
      settings,
      "body",
      "network.request.postData",
      "body",
    );
    recordActiveRedactionHits(body.applied);
    entry.postData = body.value;
  }
  return entry;
}

function redactInPageWebSocketPayload(payload: string): string {
  const settings = activeRecording.privacySettings;
  if (settings.redactWebSocketPayloads === "all") {
    recordActiveRedactionHits([
      {
        artifact: "websocket",
        class: "custom",
        action: "redacted",
        field: "websocket.payload",
        ruleId: "websocket-payload-all",
      },
    ]);
    return REDACTED_VALUE;
  }
  if (settings.redactWebSocketPayloads === "sensitive-fields") {
    const redaction = redactBodyText(
      payload,
      settings,
      "websocket",
      "websocket.payload",
      "websocket",
    );
    recordActiveRedactionHits(redaction.applied);
    return redaction.value || "";
  }
  return payload;
}

/** Redacts an in-page-captured `WebSocketEntry` (URL + frame payloads). */
function redactInPageWebSocketEntry(entry: WebSocketEntry): WebSocketEntry {
  const settings = activeRecording.privacySettings;
  const urlResult = redactUrl(entry.url, settings, "websocket", "websocket.url");
  recordActiveRedactionHits(urlResult.applied);
  entry.url = urlResult.value || entry.url;
  entry.frames = entry.frames.map((frame) => ({
    ...frame,
    payloadData: redactInPageWebSocketPayload(frame.payloadData),
  }));
  return entry;
}

function redactInPageStorageItems(
  items: StorageKeyValue[],
  fieldPrefix: string,
): StorageKeyValue[] {
  const settings = activeRecording.privacySettings;
  return items.map((item) => {
    // Wrap as `{ [key]: value }` so the shared policy classifies the storage key
    // by name and still applies value-based rules (same pattern as cdp-manager).
    const result = redactJsonValue(
      { [item.key]: item.value },
      settings,
      "storage",
      fieldPrefix,
      "body",
    );
    if (result.applied.length > 0) {
      recordActiveRedactionHits(result.applied);
    }
    const redactedValue = (result.value as Record<string, unknown>)[item.key];
    return {
      key: item.key,
      value: typeof redactedValue === "string" ? redactedValue : String(redactedValue),
      redacted: result.applied.length > 0 ? true : item.redacted,
    };
  });
}

function redactInPageCookie(cookie: CookieRecord): CookieRecord {
  const settings = activeRecording.privacySettings;
  const result = redactJsonValue(
    { [cookie.name]: cookie.value },
    settings,
    "storage",
    "storage.cookies",
    "body",
  );
  if (result.applied.length > 0) {
    recordActiveRedactionHits(result.applied);
  }
  const redactedValue = (result.value as Record<string, unknown>)[cookie.name];
  return {
    ...cookie,
    value: typeof redactedValue === "string" ? redactedValue : String(redactedValue),
    redacted: result.applied.length > 0 ? true : cookie.redacted,
  };
}

/**
 * Redacts an in-page-captured `StorageSnapshot` before buffering, honoring the
 * `redactStorageValues` toggle exactly as the CDP storage-capture path does.
 */
function redactInPageStorageSnapshot(snapshot: StorageSnapshot): StorageSnapshot {
  const redactValues = activeRecording.recordingSettings?.redactStorageValues ?? true;
  if (!redactValues) {
    return snapshot;
  }
  snapshot.localStorage = redactInPageStorageItems(snapshot.localStorage, "storage.localStorage");
  snapshot.sessionStorage = redactInPageStorageItems(
    snapshot.sessionStorage,
    "storage.sessionStorage",
  );
  snapshot.cookies = snapshot.cookies.map((cookie) => redactInPageCookie(cookie));
  return snapshot;
}

/**
 * Routes a bridged in-page capture entry (RECORDING_INPAGE_ENTRY) into the
 * `StorageManager`, applying service-worker-side redaction first — mirroring the
 * `RECORDING_USER_EVENT` flow. Only entries for the active session and tab are
 * accepted. Console entries are buffered as-is because `finalizeCurrentSession()`
 * redacts them via `redactConsoleEntry` (consistent with the CDP path).
 */
function handleRecordingInPageEntry(
  data: Record<string, unknown> | undefined,
  sender: chrome.runtime.MessageSender,
): MessageResponse {
  const sessionId = typeof data?.sessionId === "string" ? data.sessionId : "";
  if (
    !sessionId ||
    sessionId !== activeRecording.sessionId ||
    sender.tab?.id !== activeRecording.tabId ||
    !activeRecording.isRecording
  ) {
    return { ok: true };
  }

  const entry = data?.entry;
  if (!entry || typeof entry !== "object") {
    return { ok: true };
  }

  switch (data?.kind) {
    case "console":
      storage.addConsoleEntry(entry as ConsoleEntry);
      break;
    case "network":
      storage.addNetworkEntry(redactInPageNetworkEntry(entry as NetworkEntry));
      break;
    case "websocket":
      // In-page WebSocket capture emits a cumulative snapshot per frame/close, so
      // replace any prior entry for the same socket by requestId to avoid dupes.
      storage.upsertWebSocketEntry(redactInPageWebSocketEntry(entry as WebSocketEntry));
      break;
    case "storage":
      storage.setStorageSnapshot(redactInPageStorageSnapshot(entry as StorageSnapshot));
      break;
    default:
      break;
  }

  return { ok: true };
}

async function captureVisibleTabScreenshot(tabId: number | null): Promise<string | undefined> {
  if (tabId == null) {
    return undefined;
  }

  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active || tab.windowId == null) {
      return undefined;
    }

    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "jpeg",
      quality: 70,
    });
    if (dataUrl.length > MAX_SCREENSHOT_DATA_URL_CHARS) {
      addActivePrivacyLimitation(
        "The stop-time screenshot was skipped because it exceeded the size limit.",
      );
      console.warn("[GN Tracing] Skipping screenshot artifact because it exceeded the size limit.");
      return undefined;
    }
    return dataUrl;
  } catch (error) {
    addActivePrivacyLimitation("The stop-time screenshot could not be captured.");
    console.warn("[GN Tracing] Screenshot capture unavailable:", error);
    return undefined;
  }
}

function handleRecordingUserEvent(
  data: Record<string, unknown> | undefined,
  sender: chrome.runtime.MessageSender,
): MessageResponse {
  const sessionId = typeof data?.sessionId === "string" ? data.sessionId : "";
  if (
    !sessionId ||
    sessionId !== activeRecording.sessionId ||
    sender.tab?.id !== activeRecording.tabId
  ) {
    return { ok: true };
  }

  if (Array.isArray(data?.redactionHits)) {
    recordActiveRedactionHits(data.redactionHits as RedactionHit[]);
  }
  if (Array.isArray(data?.limitations)) {
    for (const limitation of data.limitations) {
      if (typeof limitation === "string") {
        addActivePrivacyLimitation(limitation);
      }
    }
  }

  const environment = normalizeCaptureEnvironment(data?.environment);
  if (environment) {
    activeRecording.environment = environment;
  }

  const event = normalizeRecordingUserEvent(data?.event);
  if (event) {
    const redactedEvent = redactUserEvent(event, activeRecording.privacySettings);
    recordActiveRedactionHits(redactedEvent.applied);
    const safeEvent = redactedEvent.value;
    if (event.type === "navigation") {
      activeRecording.tabUrl =
        safeEvent.type === "navigation" ? safeEvent.url : activeRecording.tabUrl;
      activeRecording.tabTitle =
        safeEvent.type === "navigation"
          ? safeEvent.title || activeRecording.tabTitle
          : activeRecording.tabTitle;
      // R7.1: capture a DOM snapshot at important marker events (NOT continuously).
      // Navigation is a discrete, meaningful marker; per-click capture is avoided
      // because it would approximate continuous capture. Fire-and-forget: the
      // capture path is internally guarded (records a limitation on failure) so it
      // never blocks event handling.
      if (activeRecording.recordingSettings?.captureDomSnapshots) {
        void cdp.captureDomSnapshot("marker:navigation");
      }
    }
    activeRecording.userEvents.push(safeEvent);
    if (activeRecording.userEvents.length > MAX_RECORDED_USER_EVENTS) {
      activeRecording.userEvents.splice(
        0,
        activeRecording.userEvents.length - MAX_RECORDED_USER_EVENTS,
      );
    }
  }

  return { ok: true };
}

function buildPrivacyArtifactFlags(
  settings: UploadSettingsStore,
  finalizedArtifacts: {
    consoleLogs?: string;
    networkRequests?: string;
    webSocketLogs?: string;
    storageSnapshots?: string;
    domSnapshots?: string;
  },
  userEventArtifact: RecordingUserEventArtifact | null,
  screenshotDataUrl: string | undefined,
): RecordingPrivacySummary["artifactFlags"] {
  return {
    video: true,
    screenshot: Boolean(screenshotDataUrl),
    report: true,
    events: Boolean(userEventArtifact),
    console: Boolean(finalizedArtifacts.consoleLogs),
    network: Boolean(finalizedArtifacts.networkRequests),
    websocket: Boolean(finalizedArtifacts.webSocketLogs),
    requestBodies: Boolean(settings.captureNetwork && settings.captureRequestBodies),
    responseBodies: Boolean(settings.captureNetwork && settings.captureResponseBodyMode !== "off"),
    websocketPayloads: Boolean(settings.captureWebSockets && settings.captureWebSocketFrames),
    sourceSnippets: settings.captureConsoleSourceSnippets !== "off",
    storage: Boolean(finalizedArtifacts.storageSnapshots),
    dom: Boolean(finalizedArtifacts.domSnapshots),
  };
}

function buildPrivacySummary(
  settings: UploadSettingsStore,
  stopTime: number,
  finalizedArtifacts: {
    consoleLogs?: string;
    networkRequests?: string;
    webSocketLogs?: string;
    storageSnapshots?: string;
    domSnapshots?: string;
  },
  userEventArtifact: RecordingUserEventArtifact | null,
  screenshotDataUrl: string | undefined,
): RecordingPrivacySummary {
  const limitations = [...activeRecording.privacyLimitations];
  if (settings.captureResponseBodyMode !== "off") {
    limitations.push("Binary or base64 response bodies are not parsed for field-level redaction.");
  }
  if (settings.captureWebSockets && settings.captureWebSocketFrames) {
    limitations.push("Binary WebSocket payloads are not parsed for field-level redaction.");
  }
  if (settings.maskDomSelectors.length > 0) {
    limitations.push(
      "Selector-based visual masking does not cover canvas, video, closed shadow DOM, or content drawn outside matched elements.",
    );
  }

  return buildRecordingPrivacySummary(
    settings,
    buildPrivacyArtifactFlags(settings, finalizedArtifacts, userEventArtifact, screenshotDataUrl),
    activeRecording.redactionHits,
    limitations,
    new Date(stopTime).toISOString(),
  );
}

async function startRecording(tabId: number): Promise<MessageResponse> {
  if (activeRecording.isRecording) {
    return { ok: false, error: "Already recording" };
  }

  try {
    const settings = await getUploadSettings();
    const tab = await chrome.tabs.get(tabId);
    const target = getRecordingTabTarget(tab);
    if (target.error) {
      return { ok: false, error: target.error };
    }

    const sessionId = createSessionId();
    activeRecording.sessionId = sessionId;
    activeRecording.isRecording = false;
    activeRecording.tabId = tabId;
    // startTime is set only after MediaRecorder actually starts so event
    // relativeMs stays aligned with video.currentTime (not setup latency).
    activeRecording.startTime = null;
    activeRecording.stopTime = null;
    activeRecording.tabUrl = target.url;
    activeRecording.tabTitle = typeof tab.title === "string" ? tab.title : null;
    activeRecording.environment = buildFallbackEnvironment();
    activeRecording.userEvents = [];
    activeRecording.redactionHits = [];
    activeRecording.privacyLimitations = [];
    activeRecording.privacySettings = pickPrivacyRedactionSettings(settings);
    activeRecording.recordingSettings = settings;

    storage.beginSession();
    storage.setCaptureSettings(settings);
    storage.setPrivacySettings(activeRecording.privacySettings, recordActiveRedactionHits);
    cdp.setCaptureSettings(settings);
    cdp.setPrivacySettings(activeRecording.privacySettings, recordActiveRedactionHits);

    const inPageMode = settings.captureMode === "in-page";
    if (inPageMode) {
      // R9.2: in-page mode must NOT attach chrome.debugger (no debugger banner).
      // Video capture via the recorder is independent of CDP, so it still runs.
      await recorder.startCapture(tabId, sessionId);
      await startInPageCapture(tabId, sessionId);
      // R9.5: declare the fidelity ceiling inherent to in-page instrumentation.
      addActivePrivacyLimitation(
        "In-page capture mode: cross-origin response bodies and real source maps are unavailable.",
      );
    } else {
      await Promise.all([cdp.attach(tabId), recorder.startCapture(tabId, sessionId)]);

      if (settings.captureStorage) {
        await cdp.captureStorageSnapshot("start");
      }
      if (settings.captureDomSnapshots) {
        await cdp.captureDomSnapshot("start");
      }
    }

    // Align wall-clock origin with the first captured video frame timeline.
    activeRecording.startTime = Date.now();
    activeRecording.isRecording = true;
    recorder.hydrateActiveSession(sessionId);
    void startRecordingEventCapture(tabId, sessionId, activeRecording.privacySettings);
    void startDrawingOverlay(tabId, sessionId);

    chrome.action.setBadgeText({ text: "REC" });
    chrome.action.setBadgeBackgroundColor({ color: "#ef233c" });
    chrome.alarms.create("gn-tracing-keepalive", { periodInMinutes: 0.4 });

    await saveStateToStorage();
    return { ok: true };
  } catch (error) {
    await stopRecordingEventCapture(tabId);
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

    await stopDrawingOverlay(activeRecording.tabId);
    await stopRecordingEventCapture(activeRecording.tabId);
    await recorder.stopCapture();
    const screenshotDataUrl = await captureVisibleTabScreenshot(activeRecording.tabId);

    const inPageMode = activeRecording.recordingSettings?.captureMode === "in-page";
    let sourceMapDiagnostics: SourceMapDiagnosticsArtifact | null = null;

    if (inPageMode) {
      // R9.2: no debugger was attached in in-page mode, so skip all CDP teardown
      // (flush/detach/source maps). Signal the in-page capture to stop: its
      // cleanup restores patched globals (R9.4) and emits the final "stop"
      // storage snapshot over the bridge.
      await stopInPageCapture(activeRecording.tabId, sessionId);
      // Allow the MAIN→relay→service-worker bridge to deliver in-flight entries
      // (notably the stop storage snapshot) before finalizing the session.
      await waitForInPageDrain();
    } else {
      // Keep CDP attached while flushing source maps, but stop media capture
      // first so the video length matches the user's stop action as closely as
      // possible.
      await cdp.flushSourceMaps();
      if (activeRecording.recordingSettings?.captureStorage) {
        await cdp.captureStorageSnapshot("stop");
      }
      if (activeRecording.recordingSettings?.captureDomSnapshots) {
        await cdp.captureDomSnapshot("stop");
      }
      for (const limitation of cdp.getStorageLimitations()) {
        addActivePrivacyLimitation(limitation);
      }
      try {
        await cdp.detach();
      } catch {
        // Capture has already stopped, so detach failures should not block finalization.
      }
      const sourceMapDiagnosticsSnapshot = cdp.getSourceMapDiagnostics();
      storage.resolveSourceMaps(cdp.sourceMapResolver, sourceMapDiagnosticsSnapshot);
      sourceMapDiagnostics = buildSourceMapDiagnosticsArtifact(stopTime);
      cdp.releaseSourceMaps();
    }

    const finalizedArtifacts = storage.finalizeCurrentSession();
    const report = buildRecordingReport(stopTime);
    const userEventArtifact = buildUserEventArtifact(activeRecording.userEvents);
    const drawingArtifact = buildDrawingArtifact(
      activeRecording.drawingStrokes,
      activeRecording.drawingClears,
    );
    const recordingSettings = activeRecording.recordingSettings || {
      ...(await getUploadSettings()),
      ...activeRecording.privacySettings,
    };
    const privacy = buildPrivacySummary(
      recordingSettings,
      stopTime,
      finalizedArtifacts,
      userEventArtifact,
      screenshotDataUrl,
    );
    sessionArtifacts[sessionId] = {
      consoleLogs: finalizedArtifacts.consoleLogs,
      networkRequests: finalizedArtifacts.networkRequests,
      webSocketLogs: finalizedArtifacts.webSocketLogs,
      report: JSON.stringify(report),
      userEvents: userEventArtifact ? JSON.stringify(userEventArtifact) : undefined,
      drawing: drawingArtifact,
      privacy: JSON.stringify(privacy),
      diagnostics: sourceMapDiagnostics ? JSON.stringify(sourceMapDiagnostics) : undefined,
      storage: finalizedArtifacts.storageSnapshots,
      dom: finalizedArtifacts.domSnapshots,
      screenshotDataUrl,
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

    const settings = await getUploadSettings();
    const resolved = requireRegisteredStorageProvider(settings.activeStorageProvider);
    if (resolved.ok) {
      const authToken = await resolved.provider.getAuthToken();
      if (authToken) {
        void startSessionUploadTask(sessionId, authToken);
      }
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

    await stopDrawingOverlay(activeRecording.tabId);
    await stopRecordingEventCapture(activeRecording.tabId);
    if (activeRecording.recordingSettings?.captureMode === "in-page") {
      // R9.4: restore patched page globals even when the recording is discarded.
      await stopInPageCapture(activeRecording.tabId, sessionId);
    }
    await Promise.allSettled([recorder.stopCapture(true), cdp.detach()]);

    storage.clear();
    cdp.releaseSourceMaps();
    activeRecording.drawingStrokes = [];
    activeRecording.drawingOverlayActive = false;
    delete sessionArtifacts[sessionId];

    chrome.action.setBadgeText({ text: "" });
    chrome.alarms.clear("gn-tracing-keepalive");

    resetActiveRecordingState();
    await saveArtifactsToStorage();
    await saveStateToStorage();

    void chrome.runtime
      .sendMessage({
        target: "offscreen",
        type: "DELETE_SESSION_SNAPSHOT",
        data: { sessionId },
      })
      .catch(() => {});

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

async function getPopupSettingsResponse(): Promise<
  MessageResponse & {
    settings: UploadSettings;
    uploadHistory: UploadHistoryEntry[];
  }
> {
  const [settings, uploadHistory] = await Promise.all([getUploadSettings(), getUploadHistory()]);

  return {
    ok: true,
    settings: getSettingsSnapshot(settings),
    uploadHistory,
  };
}

async function persistUploadHistory(
  session: RecordingSessionSummary,
  targetFolderId: string | null,
  provider: StorageProviderId = "google-drive",
): Promise<void> {
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
    provider,
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

  void chrome.runtime
    .sendMessage({
      target: "offscreen",
      type: "DELETE_SESSION_SNAPSHOT",
      data: { sessionId },
    })
    .catch(() => {});

  return { ok: true };
}

async function updateUploadSettingsFromMessage(
  data: Record<string, unknown> | undefined,
): Promise<MessageResponse & { settings?: UploadSettings }> {
  const existingSettings = await getUploadSettings();
  const hasFolderInput = typeof data?.folderInput === "string";
  const hasZipPassword = typeof data?.zipPassword === "string";
  const shouldClearZipPassword = data?.clearZipPassword === true;

  // Resolve next active provider first so folder parsing uses the right rules.
  let nextActiveStorageProvider = existingSettings.activeStorageProvider;
  if (data && "activeStorageProvider" in data) {
    const requestedProvider = normalizeStorageProviderId(
      data.activeStorageProvider,
      existingSettings.activeStorageProvider,
    );
    const registered = requireRegisteredStorageProvider(requestedProvider);
    if (!registered.ok) {
      return {
        ok: false,
        error: registered.error,
      };
    }
    nextActiveStorageProvider = registered.provider.id;
  }

  let nextFolder: ProviderFolderSettings;
  if (hasFolderInput) {
    nextFolder = parseFolderInputForProvider(
      nextActiveStorageProvider,
      data?.folderInput as string,
    );
    // Reject unparseable non-empty input (Drive: not path/id/link; path clouds: not a clean path).
    if (nextFolder.folderInput && !nextFolder.folderId && nextFolder.folderPath.length === 0) {
      if (nextActiveStorageProvider === "dropbox") {
        return {
          ok: false,
          error:
            "Invalid Dropbox folder input. Use a slash path like /gn-tracing (no . or .. segments), or leave blank for root.",
        };
      }
      return {
        ok: false,
        error:
          "Invalid Google Drive folder input. Use /folder/path, a folder ID, or a Google Drive folder link.",
      };
    }
  } else if (nextActiveStorageProvider !== existingSettings.activeStorageProvider) {
    // Provider switch without new folder: restore that provider's saved folder.
    const saved = existingSettings.folderByProvider[nextActiveStorageProvider];
    nextFolder = saved
      ? {
          folderInput: saved.folderInput,
          folderId: saved.folderId,
          folderPath: [...saved.folderPath],
        }
      : parseFolderInputForProvider(nextActiveStorageProvider, "/gn-tracing");
  } else {
    nextFolder = {
      folderInput: existingSettings.folderInput,
      folderId: existingSettings.folderId,
      folderPath: [...existingSettings.folderPath],
    };
  }

  const nextFolderByProvider: Partial<Record<StorageProviderId, ProviderFolderSettings>> = {
    ...existingSettings.folderByProvider,
    [nextActiveStorageProvider]: {
      folderInput: nextFolder.folderInput,
      folderId: nextFolder.folderId,
      folderPath: [...nextFolder.folderPath],
    },
  };
  // When switching provider, also persist the previous provider's current folder.
  if (nextActiveStorageProvider !== existingSettings.activeStorageProvider) {
    nextFolderByProvider[existingSettings.activeStorageProvider] = {
      folderInput: existingSettings.folderInput,
      folderId: existingSettings.folderId,
      folderPath: [...existingSettings.folderPath],
    };
  }

  const requestedProfile = normalizeEnum<CaptureProfile>(
    data?.captureProfile,
    ["lean", "balanced", "full", "custom"],
    existingSettings.captureProfile,
  );
  const profileSettings = getCaptureProfileSettings(
    requestedProfile === "custom" ? "full" : requestedProfile,
  );
  // Choosing a named preset is an explicit reset to that preset, even when the stored profile name is already selected.
  const baseCaptureSettings = requestedProfile !== "custom" ? profileSettings : existingSettings;
  // UI clients mark manual advanced edits by switching the requested profile to Custom before saving.
  // Named profile saves may include the expanded preset fields, but they should remain on that named profile.
  const nextCaptureProfile = requestedProfile;
  const nextCaptureResponseBodyMode = normalizeEnum<ResponseBodyCaptureMode>(
    data?.captureResponseBodyMode,
    ["off", "text", "text-json", "eligible"],
    baseCaptureSettings.captureResponseBodies ? baseCaptureSettings.captureResponseBodyMode : "off",
  );
  const nextCaptureResponseBodies =
    typeof data?.captureResponseBodies === "boolean"
      ? data.captureResponseBodies
      : nextCaptureResponseBodyMode !== "off";
  const requestedPrivacyProfile = normalizeEnum<PrivacyProfile>(
    data?.privacyProfile,
    ["standard", "strict", "custom"],
    existingSettings.privacyProfile,
  );
  const privacyProfileSettings = getPrivacyProfileSettings(
    requestedPrivacyProfile === "custom" ? "standard" : requestedPrivacyProfile,
  );
  const basePrivacySettings =
    requestedPrivacyProfile !== "custom" ? privacyProfileSettings : existingSettings;

  const settings: UploadSettingsStore = {
    activeStorageProvider: nextActiveStorageProvider,
    folderInput: nextFolder.folderInput,
    folderId: nextFolder.folderId,
    folderPath: nextFolder.folderPath,
    folderByProvider: nextFolderByProvider,
    // Keep plaintext password out of popup snapshots; it is only read here for uploads.
    zipPassword: shouldClearZipPassword
      ? ""
      : hasZipPassword
        ? (data.zipPassword as string)
        : existingSettings.zipPassword,
    captureProfile: nextCaptureProfile,
    privacyProfile: requestedPrivacyProfile,
    redactSensitiveHeaders: normalizeBoolean(
      data?.redactSensitiveHeaders,
      basePrivacySettings.redactSensitiveHeaders,
    ),
    redactSensitiveQueryParams: normalizeBoolean(
      data?.redactSensitiveQueryParams,
      basePrivacySettings.redactSensitiveQueryParams,
    ),
    redactRequestBodyFields: normalizeBoolean(
      data?.redactRequestBodyFields,
      basePrivacySettings.redactRequestBodyFields,
    ),
    redactResponseBodyFields: normalizeBoolean(
      data?.redactResponseBodyFields,
      basePrivacySettings.redactResponseBodyFields,
    ),
    redactConsoleValues: normalizeBoolean(
      data?.redactConsoleValues,
      basePrivacySettings.redactConsoleValues,
    ),
    redactWebSocketPayloads: normalizeEnum(
      data?.redactWebSocketPayloads,
      ["off", "sensitive-fields", "all"],
      basePrivacySettings.redactWebSocketPayloads,
    ),
    redactEventMetadata: normalizeBoolean(
      data?.redactEventMetadata,
      basePrivacySettings.redactEventMetadata,
    ),
    maskDomSelectors: normalizeMaskDomSelectors(
      Object.hasOwn(data || {}, "maskDomSelectors")
        ? data?.maskDomSelectors
        : basePrivacySettings.maskDomSelectors,
    ),
    captureConsole: normalizeBoolean(data?.captureConsole, baseCaptureSettings.captureConsole),
    captureConsoleArgs: normalizeBoolean(
      data?.captureConsoleArgs,
      baseCaptureSettings.captureConsoleArgs,
    ),
    consolePreviewDepth: normalizeEnum<ConsolePreviewDepth>(
      data?.consolePreviewDepth,
      ["none", "shallow", "full"],
      baseCaptureSettings.consolePreviewDepth,
    ),
    captureConsoleStacks: normalizeEnum<ConsoleStackMode>(
      data?.captureConsoleStacks,
      ["off", "errors", "warnings-errors", "all"],
      baseCaptureSettings.captureConsoleStacks,
    ),
    captureConsoleSourceSnippets: normalizeEnum<ConsoleSourceSnippetMode>(
      data?.captureConsoleSourceSnippets,
      ["off", "errors", "warnings-errors", "all"],
      baseCaptureSettings.captureConsoleSourceSnippets,
    ),
    maxConsoleEntryBytes: normalizeOptionalNumber(
      data?.maxConsoleEntryBytes,
      baseCaptureSettings.maxConsoleEntryBytes,
      1024,
      512 * 1024,
    ),
    captureNetwork: normalizeBoolean(data?.captureNetwork, baseCaptureSettings.captureNetwork),
    captureRequestHeaders: normalizeEnum<HeaderCaptureMode>(
      data?.captureRequestHeaders,
      ["off", "minimal", "full"],
      baseCaptureSettings.captureRequestHeaders,
    ),
    captureResponseHeaders: normalizeEnum<HeaderCaptureMode>(
      data?.captureResponseHeaders,
      ["off", "minimal", "full"],
      baseCaptureSettings.captureResponseHeaders,
    ),
    captureRequestBodies: normalizeBoolean(
      data?.captureRequestBodies,
      baseCaptureSettings.captureRequestBodies,
    ),
    captureResponseBodies: nextCaptureResponseBodies,
    captureResponseBodyMode: nextCaptureResponseBodies ? nextCaptureResponseBodyMode : "off",
    maxResponseBodyBytes: normalizeOptionalNumber(
      data?.maxResponseBodyBytes,
      baseCaptureSettings.maxResponseBodyBytes,
      0,
      10 * 1024 * 1024,
    ),
    captureRedirectHeaders: normalizeEnum<RedirectHeaderCaptureMode>(
      data?.captureRedirectHeaders,
      ["off", "location", "full"],
      baseCaptureSettings.captureRedirectHeaders,
    ),
    captureInitiator: normalizeEnum<InitiatorCaptureMode>(
      data?.captureInitiator,
      ["off", "summary", "short-stack", "full-stack"],
      baseCaptureSettings.captureInitiator,
    ),
    suppressRecorderInternalRequests: normalizeBoolean(
      data?.suppressRecorderInternalRequests,
      baseCaptureSettings.suppressRecorderInternalRequests,
    ),
    captureWebSockets: normalizeBoolean(
      data?.captureWebSockets,
      baseCaptureSettings.captureWebSockets,
    ),
    captureWebSocketFrames: normalizeBoolean(
      data?.captureWebSocketFrames,
      baseCaptureSettings.captureWebSocketFrames,
    ),
    maxWebSocketFrameBytes: normalizeOptionalNumber(
      data?.maxWebSocketFrameBytes,
      baseCaptureSettings.maxWebSocketFrameBytes,
      0,
      1024 * 1024,
    ),
    captureWebSocketInitiator: normalizeBoolean(
      data?.captureWebSocketInitiator,
      baseCaptureSettings.captureWebSocketInitiator,
    ),
    // Inspector capture toggles are profile-independent; preserve existing values when absent.
    captureStorage: normalizeBoolean(data?.captureStorage, existingSettings.captureStorage),
    redactStorageValues: normalizeBoolean(
      data?.redactStorageValues,
      existingSettings.redactStorageValues,
    ),
    captureDomSnapshots: normalizeBoolean(
      data?.captureDomSnapshots,
      existingSettings.captureDomSnapshots,
    ),
    redactDomTextContent: normalizeBoolean(
      data?.redactDomTextContent,
      existingSettings.redactDomTextContent,
    ),
    // Capture mechanism is profile-independent; default to stored value, fall back to "cdp" (R9.1).
    captureMode: normalizeEnum<CaptureMode>(
      data?.captureMode,
      ["cdp", "in-page"],
      existingSettings.captureMode,
    ),
  };
  // Coupling (product rule): enabling network/request capture also forces
  // storage and DOM snapshot capture on. Redaction toggles are left intact.
  if (settings.captureNetwork) {
    settings.captureStorage = true;
    settings.captureDomSnapshots = true;
  }
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
  // Message name is historical; upload uses the active registered storage provider.
  const requestedSessionId =
    typeof data?.sessionId === "string"
      ? data.sessionId
      : sessions.find(
          (session) =>
            (session.phase === "recorded" || session.phase === "failed") &&
            session.hasLocalSnapshot,
        )?.id;

  if (!requestedSessionId) {
    return { ok: false, error: "No recorded session is available for upload." };
  }

  const settings = await getUploadSettings();
  const resolved = requireRegisteredStorageProvider(settings.activeStorageProvider);
  if (!resolved.ok) {
    return { ok: false, error: resolved.error };
  }
  const authToken = await resolved.provider.getAuthToken();
  if (!authToken) {
    return {
      ok: false,
      error: `Not connected to ${providerDisplayName(resolved.provider.id)}. Please connect first.`,
    };
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

  const task = runSessionUpload(sessionId, authToken).finally(() => {
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
    // Label metadata/replay with the registered provider that actually uploads.
    // Never claim Dropbox when only Drive is used (or vice versa).
    const storageProviderId: StorageProviderId = resolveRegisteredUploadProviderId(
      settings.activeStorageProvider,
    );
    // Dropbox folder resolve uses path segments; pass path as targetFolderId.
    const targetFolderId =
      storageProviderId === "dropbox"
        ? settings.folderPath.length > 0
          ? `/${settings.folderPath.join("/")}`
          : null
        : settings.folderId;
    const result = (await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "UPLOAD_TO_STORAGE",
      data: {
        sessionId,
        artifactKeys: {
          consoleLogs: Boolean(artifacts.consoleLogs),
          networkRequests: Boolean(artifacts.networkRequests),
          webSocketLogs: Boolean(artifacts.webSocketLogs),
          report: Boolean(artifacts.report),
          userEvents: Boolean(artifacts.userEvents),
          drawing: Boolean(artifacts.drawing),
          privacy: Boolean(artifacts.privacy),
          diagnostics: Boolean(artifacts.diagnostics),
          storage: Boolean(artifacts.storage),
          dom: Boolean(artifacts.dom),
          screenshot: Boolean(artifacts.screenshotDataUrl),
        },
        duration: artifacts.duration,
        url: artifacts.url,
        startTime: artifacts.startTime,
        screenshotDataUrl: artifacts.screenshotDataUrl || null,
        authToken,
        targetFolderId,
        targetFolderPath: settings.folderPath,
        zipPassword: settings.zipPassword || null,
        storageProvider: storageProviderId,
      },
    })) as MessageResponse & Partial<UploadSuccessResult>;

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

    await chrome.runtime
      .sendMessage({
        target: "offscreen",
        type: "DELETE_SESSION_SNAPSHOT",
        data: { sessionId },
      })
      .catch(() => {});
    await closeOffscreenDocumentIfIdle();

    if (updatedSession) {
      await persistUploadHistory(
        updatedSession,
        typeof result.targetFolderId === "string" ? result.targetFolderId : settings.folderId,
        storageProviderId,
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
