/**
 * Main extension service worker for recording, state, upload, and message routing.
 */

import { parseGoogleDriveFolderInput } from "../shared/google-drive-folder";
import {
  buildRecordingPrivacySummary,
  getPrivacyProfileSettings,
  normalizeMaskDomSelectors,
  redactReport,
  redactUserEvent,
} from "../shared/privacy-redaction";
import { getRecordingTabTarget } from "../shared/recording-target";
import type {
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
  RecordingPrivacySummary,
  RecordingReport,
  RecordingUserEvent,
  RecordingUserEventArtifact,
  RedactionHit,
  SourceMapDiagnosticsArtifact,
} from "../types/recording";
import {
  buildFallbackEnvironment,
  normalizeCaptureEnvironment,
  normalizeRecordingUserEvent,
  truncateEventString,
} from "./capture-environment";
import { CdpManager } from "./cdp-manager";
import { GoogleDriveAuth } from "./google-drive-auth";
import { registerMessageListeners } from "./message-router";
import { RecorderManager } from "./recorder-manager";
import type { UploadSettingsStore } from "./settings-store";
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
  pickPrivacyRedactionSettings,
  STORAGE_KEY_STATE,
  saveUploadHistory,
  saveUploadSettings,
} from "./settings-store";
import { StorageManager } from "./storage-manager";
import type { UploadSuccessResult } from "./upload-orchestrator";
import { getUploadArtifactChunk } from "./upload-orchestrator";

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
  tabTitle: string | null;
  environment: CaptureEnvironment | null;
  userEvents: RecordingUserEvent[];
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
  privacy?: string;
  diagnostics?: string;
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
const MAX_RECORDED_USER_EVENTS = 2000;
const MAX_SCREENSHOT_DATA_URL_CHARS = 1536 * 1024;
const RECORDING_EVENTS_SCRIPT = "content/recording-events.js";

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
  redactionHits: [],
  privacyLimitations: [],
  privacySettings: DEFAULT_PRIVACY_REDACTION_SETTINGS,
  recordingSettings: null,
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

async function buildPopupState(): Promise<PopupState> {
  const [settings, uploadHistory] = await Promise.all([getUploadSettings(), getUploadHistory()]);
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
  uploadSessionToGoogleDrive,
  getUploadState: () => sortSessions(sessions),
  googleDriveConnect: async () => {
    const result = await googleAuth.launchOAuthFlow();
    if (result.ok) {
      await refreshGoogleDriveState();
      await saveStateToStorage();
    }
    return result;
  },
  googleDriveDisconnect: async () => {
    const result = await googleAuth.disconnect();
    await refreshGoogleDriveState();
    await saveStateToStorage();
    return result;
  },
  googleDriveStatus: async () => {
    const status = await googleAuth.getStatus();
    googleDriveState.isConnected = status.isConnected;
    googleDriveState.checkedAt = Date.now();
    await saveStateToStorage();
    return { ok: true, ...status };
  },
  getGoogleDriveToken: async () => ({ ok: true, token: await googleAuth.getAuthToken() }),
  onRecordingComplete: (sessionId) => {
    recorder.onRecordingComplete(sessionId);
  },
  getUploadArtifactChunk: (data) => getUploadArtifactChunk(sessionArtifacts, data),
  patchUploadProgress,
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
  };
}

function buildPrivacySummary(
  settings: UploadSettingsStore,
  stopTime: number,
  finalizedArtifacts: {
    consoleLogs?: string;
    networkRequests?: string;
    webSocketLogs?: string;
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
    activeRecording.startTime = Date.now();
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

    await Promise.all([cdp.attach(tabId), recorder.startCapture(tabId, sessionId)]);

    activeRecording.isRecording = true;
    recorder.hydrateActiveSession(sessionId);
    void startRecordingEventCapture(tabId, sessionId, activeRecording.privacySettings);

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

    await stopRecordingEventCapture(activeRecording.tabId);
    await recorder.stopCapture();
    const screenshotDataUrl = await captureVisibleTabScreenshot(activeRecording.tabId);
    // Keep CDP attached while flushing source maps, but stop media capture first
    // so the video length matches the user's stop action as closely as possible.
    await cdp.flushSourceMaps();
    try {
      await cdp.detach();
    } catch {
      // Capture has already stopped, so detach failures should not block finalization.
    }
    const sourceMapDiagnosticsSnapshot = cdp.getSourceMapDiagnostics();
    storage.resolveSourceMaps(cdp.sourceMapResolver, sourceMapDiagnosticsSnapshot);
    const sourceMapDiagnostics = buildSourceMapDiagnosticsArtifact(stopTime);
    cdp.releaseSourceMaps();

    const finalizedArtifacts = storage.finalizeCurrentSession();
    const report = buildRecordingReport(stopTime);
    const userEventArtifact = buildUserEventArtifact(activeRecording.userEvents);
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
      privacy: JSON.stringify(privacy),
      diagnostics: sourceMapDiagnostics ? JSON.stringify(sourceMapDiagnostics) : undefined,
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

    await stopRecordingEventCapture(activeRecording.tabId);
    await Promise.allSettled([recorder.stopCapture(true), cdp.detach()]);

    storage.clear();
    cdp.releaseSourceMaps();
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
      error:
        "Invalid Google Drive folder input. Use /folder/path, a folder ID, or a Google Drive folder link.",
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
    folderInput: parsed.normalizedInput,
    folderId: parsed.folderId,
    folderPath: parsed.folderPath,
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
    const result = (await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "UPLOAD_TO_GOOGLE_DRIVE",
      data: {
        sessionId,
        artifactKeys: {
          consoleLogs: Boolean(artifacts.consoleLogs),
          networkRequests: Boolean(artifacts.networkRequests),
          webSocketLogs: Boolean(artifacts.webSocketLogs),
          report: Boolean(artifacts.report),
          userEvents: Boolean(artifacts.userEvents),
          privacy: Boolean(artifacts.privacy),
          diagnostics: Boolean(artifacts.diagnostics),
          screenshot: Boolean(artifacts.screenshotDataUrl),
        },
        duration: artifacts.duration,
        url: artifacts.url,
        startTime: artifacts.startTime,
        screenshotDataUrl: artifacts.screenshotDataUrl || null,
        authToken,
        targetFolderId: settings.folderId,
        targetFolderPath: settings.folderPath,
        zipPassword: settings.zipPassword || null,
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
