/**
 * Main extension service worker for recording, state, upload, and message routing.
 */

import type { Screenshot } from "../../packages/replay-core/src/schema/annotation";
import type { DomSnapshot } from "../../packages/replay-core/src/schema/capture";
import { getMediaMessageTarget } from "../platform/media/message-target";
import { createRecordingRuntime } from "../platform/recording-runtime/create-recording-runtime";
import type { EvidenceEntry } from "../platform/recording-runtime/types";
import { CAPTURE_PAGE_DOM_SNAPSHOT_ACTION } from "../shared/capture-page-dom";
import { normalizeDrawColor } from "../shared/drawing";
import {
  redactInPageNetworkEntry as applyInPageNetworkRedaction,
  redactInPageStorageSnapshot as applyInPageStorageRedaction,
  redactInPageWebSocketEntry as applyInPageWebSocketRedaction,
} from "../shared/in-page-evidence-redaction";
import {
  normalizeInstantReplayAllowedDomains,
  tabUrlMatchesInstantReplayAllowlist,
} from "../shared/instant-replay-domain";
import { buildInstantReplayPackageArtifacts } from "../shared/instant-replay-evidence-package";
import { buildReportUploadHistoryEntry } from "../shared/instant-replay-policy";
import { normalizeInstantReplayWindowSeconds } from "../shared/instant-replay-window";
import {
  buildRecordingPrivacySummary,
  normalizeMaskDomSelectors,
  redactReport,
  redactUserEvent,
} from "../shared/privacy-redaction";
import { getRecordingTabTarget } from "../shared/recording-target";
import { normalizeStorageProviderId, type StorageProviderId } from "../shared/storage-provider";
import type {
  ConsolePreviewDepth,
  ConsoleSourceSnippetMode,
  ConsoleStackMode,
  HeaderCaptureMode,
  InitiatorCaptureMode,
  MessageResponse,
  PopupState,
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
  NetworkEntry,
  RecordingPrivacySummary,
  RecordingReport,
  RecordingUserEvent,
  RecordingUserEventArtifact,
  RedactionHit,
  SourceMapDiagnosticsArtifact,
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
import { createDevReloadClientStarter, isDevReloadSafe, startDevReloadClient } from "./dev-reload";
import {
  buildDrawingArtifact,
  enforceDrawingBudgets,
  normalizeDrawingStroke,
} from "./drawing-artifact";
import { submitFeedback } from "./feedback-submit";
import { createInstantReplayCdpHubForBrowser } from "./instant-replay-cdp";
import {
  createRegistrationDeps,
  syncInstantReplayRegistration,
} from "./instant-replay-registration";
import {
  COLLECT_INSTANT_REPLAY_ACTION,
  COMMIT_INSTANT_REPLAY_ACTION,
  type CollectInstantReplayResult,
  parseCollectInstantReplayResponse,
} from "./instant-replay-session";
import { registerMessageListeners } from "./message-router";
import {
  activeRecording,
  activeUploadTasks,
  addActivePrivacyLimitation,
  cloneProgressItems,
  createSessionId,
  dropboxState,
  getDrawingColor,
  getElapsedMs,
  getSession,
  getSessionArtifacts,
  getSessions,
  googleDriveState,
  loadPersistedArtifacts,
  patchSession,
  recordActiveRedactionHits,
  saveArtifactsToStorage,
  setDrawingColor as setActiveDrawingColor,
  setSession,
  setSessionArtifacts,
  setSessions,
  sortSessions,
} from "./runtime-state";
import {
  clearScreenshotPackageStaging,
  putScreenshotPackageStaging,
} from "./screenshot-package-staging-idb";
import {
  buildInstantReplayPending,
  captureScreenshotForAnnotation,
  clearPendingScreenshot,
  isInstantReplayPending,
  mergeAnnotatedScreenshot,
  openAnnotateEditorTab,
  readPendingScreenshot,
  readPendingStillForAnnotate,
  resolveInstantReplayForSave,
  writePendingScreenshot,
} from "./screenshot-report";
import type { ProviderFolderSettings, UploadSettingsStore } from "./settings-store";
import {
  DEFAULT_PRIVACY_REDACTION_SETTINGS,
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

declare const __APP_ENV__: string;
declare const __BROWSER_TARGET__: string;
declare const __DEV_EXTENSION_RELOAD_URL__: string;

// Dev/watch builds mint a distinct extension id (esbuild.config.mjs,
// CHROME_EXTENSION_PUBLIC_KEY_DEV) so the toolbar icon also needs a visible
// "DEV" badge — otherwise a dev build sitting next to the installed
// production extension is indistinguishable at a glance.
const IDLE_BADGE_TEXT = __APP_ENV__ === "production" ? "" : "DEV";
const IDLE_BADGE_COLOR = "#64748b";

/** Idle-state badge: empty in production, "DEV" otherwise. Recording (setBadgeText("REC")) overrides this while active. */
function setIdleBadge(): void {
  chrome.action.setBadgeText({ text: IDLE_BADGE_TEXT });
  // Skipped in production: empty badge text already hides the badge
  // regardless of color, so there is nothing to set.
  if (IDLE_BADGE_TEXT) {
    chrome.action.setBadgeBackgroundColor({ color: IDLE_BADGE_COLOR });
  }
}

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
/** Full-record evidence + media host (Chromium CDP or Firefox in-page). */
const recordingRuntime = createRecordingRuntime(storage);
/** Instant Replay CDP lookback; no-op hub on Firefox. */
const irCdpHub = createInstantReplayCdpHubForBrowser(getUploadSettings);
/** Multi-cloud storage providers from the registry (Drive + Dropbox). */
const googleDriveProvider = getGoogleDriveProvider();
const googleAuth = googleDriveProvider.getAuth();
const dropboxProvider = getDropboxProvider();
const dropboxAuth = dropboxProvider.getAuth();

void googleAuth.initialize();

interface OffscreenCaptureState {
  ok: boolean;
  isRecording?: boolean;
  activeSessionId?: string | null;
  snapshotSessionIds?: string[];
}

const STORAGE_KEY_DRAWING_COLOR = "gn_tracing_drawing_color";
const MAX_RECORDED_USER_EVENTS = 2000;
const MAX_SCREENSHOT_DATA_URL_CHARS = 1536 * 1024;
const RECORDING_EVENTS_SCRIPT = "content/recording-events.js";
const DRAWING_OVERLAY_SCRIPT = "content/drawing-overlay.js";

const startDevReloadClientOnce = createDevReloadClientStarter(() => {
  startDevReloadClient({
    appEnv: __APP_ENV__,
    browserTarget: __BROWSER_TARGET__,
    canReload: () => isDevReloadSafe(activeRecording),
    reloadUrl: __DEV_EXTENSION_RELOAD_URL__,
  });
});

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
  recordingRuntime.clearActiveSession();
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

async function buildPopupState(): Promise<PopupState> {
  const [settings, uploadHistory] = await Promise.all([getUploadSettings(), getUploadHistory()]);
  const activeProvider = settings.activeStorageProvider;
  const storageConnected = getCachedStorageConnected(activeProvider);
  return {
    recording: getRecordingStatus(),
    sessions: sortSessions(getSessions()),
    storage: {
      provider: activeProvider,
      isConnected: storageConnected,
    },
    // Shim: existing popup state still reads googleDrive.isConnected.
    // Prefer `storage` for the active provider; googleDrive always mirrors Drive.
    googleDrive: {
      isConnected: googleDriveState.isConnected,
    },
    settings: getSettingsSnapshot(settings),
    uploadHistory,
  };
}

/**
 * Serialized payload of the last successful state write.
 *
 * `chrome.storage.session.set` notifies `onChanged` even when the value is
 * unchanged, and the popup reacts to every notification by querying provider
 * status — which used to write state again, so a single non-progress update
 * turned into an endless write/render loop. Skipping no-op writes makes the
 * channel idempotent so any such cycle dies out instead of self-sustaining.
 */
let lastPersistedStateJson: string | null = null;

/**
 * Comparison key for {@link saveStateToStorage}'s no-op check.
 *
 * `elapsedMs` / `elapsedUpdatedAt` are recomputed from the clock on every build,
 * so leaving them in would make every state look new and defeat the check. The
 * popup derives the live timer from `startTime` with its own interval, so it does
 * not need a write to observe time passing.
 */
function popupStateIdentity(state: PopupState): string {
  const recording = state.recording
    ? { ...state.recording, elapsedMs: 0, elapsedUpdatedAt: 0 }
    : state.recording;
  return JSON.stringify({ ...state, recording });
}

async function saveStateToStorage(): Promise<PopupState | null> {
  try {
    const popupState = await buildPopupState();
    const identity = popupStateIdentity(popupState);
    if (identity === lastPersistedStateJson) {
      return popupState;
    }
    lastPersistedStateJson = identity;
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

async function probeMediaCaptureState(): Promise<OffscreenCaptureState | null> {
  try {
    if (recordingRuntime.mediaKind === "offscreen") {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      });
      if (contexts.length === 0) {
        return null;
      }
    }

    return (await chrome.runtime.sendMessage({
      target: getMediaMessageTarget(),
      type: "GET_CAPTURE_STATE",
    })) as OffscreenCaptureState;
  } catch {
    return null;
  }
}

async function closeMediaHostIfIdle(): Promise<void> {
  if (activeUploadTasks.size > 1) {
    return;
  }

  const mediaState = await probeMediaCaptureState();
  if (
    !mediaState?.ok ||
    mediaState.isRecording ||
    (mediaState.snapshotSessionIds || []).length > 0
  ) {
    return;
  }

  await recordingRuntime.closeMediaHostIfIdle();
}

async function syncRuntimeState(): Promise<void> {
  const persistedState = await loadPersistedPopupState();
  setSessionArtifacts(await loadPersistedArtifacts());

  setSessions(
    Array.isArray(persistedState?.sessions)
      ? persistedState.sessions.map((session) => ({
          ...session,
          items: cloneProgressItems(session.items || []),
        }))
      : [],
  );

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

  const offscreenState = await probeMediaCaptureState();
  const snapshotIds = new Set(offscreenState?.snapshotSessionIds || []);

  if (!offscreenState?.ok || !offscreenState.isRecording) {
    resetActiveRecordingState();
  } else {
    activeRecording.isRecording = Boolean(offscreenState.isRecording);
    activeRecording.sessionId = offscreenState.activeSessionId ?? activeRecording.sessionId;
    recordingRuntime.hydrateActiveSession(activeRecording.sessionId);
    // Restore capture settings for redaction/privacy after worker eviction.
    if (!activeRecording.recordingSettings) {
      const settings = await getUploadSettings();
      activeRecording.recordingSettings = settings;
      activeRecording.privacySettings = pickPrivacyRedactionSettings(settings);
    }
  }

  setSessions(
    sortSessions(
      getSessions().map((session) => {
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
    ),
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

/**
 * Aligns the always-on Instant Replay content script + CDP hub with settings.
 * Safe on every boot: disabled installs unregister; enabled installs re-register.
 */
async function syncInstantReplayRegistrationOnBoot(): Promise<void> {
  try {
    const settings = await getUploadSettings();
    await syncInstantReplayRegistration(settings.instantReplayEnabled, createRegistrationDeps());
    await irCdpHub.sync();
  } catch (error) {
    console.warn("[GN Tracing] Could not sync Instant Replay registration:", error);
  }
}

void syncRuntimeState()
  .then(() => {
    // Runs on every service-worker load (fresh boot or MV3 restart). Guard on
    // isRecording so a restart mid-recording doesn't stomp the "REC" badge.
    if (!activeRecording.isRecording) {
      setIdleBadge();
    }
    if (__APP_ENV__ === "development") {
      startDevReloadClientOnce();
    }
  })
  .catch((error) => {
    console.warn("[GN Tracing] syncRuntimeState failed on boot:", error);
  });
void syncInstantReplayRegistrationOnBoot();

chrome.runtime.onStartup.addListener(() => {
  void syncRuntimeState();
  void syncInstantReplayRegistrationOnBoot();
});

chrome.runtime.onInstalled.addListener(() => {
  void syncRuntimeState();
  void syncInstantReplayRegistrationOnBoot();
});

// IR CDP follows the focused allowlisted tab (Chromium only).
chrome.tabs.onActivated.addListener(() => {
  void irCdpHub.sync();
});
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.status === "complete" || typeof changeInfo.url === "string") {
    void irCdpHub.sync();
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "gn-tracing-keepalive") {
    return;
  }
  // The wake itself is the point: on Firefox the background is an event page
  // that unloads when idle, and an unload during the share-picker wait destroys
  // the suspended start() continuation. The alarm fires inside that idle
  // timeout, so the page never goes away mid-start. No body needed.
  //
  // Deliberately NOT gated on activeRecording.isRecording: that flag is only
  // set after the user has picked a share target, which is precisely the
  // window this alarm exists to protect.
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
  ensureMediaHost,
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
  uploadSessionToGoogleDrive,
  getUploadState: () => sortSessions(getSessions()),
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
    // Deliberately no saveStateToStorage(): this is a read-only query and the
    // answer goes back in the response. Broadcasting it re-entered the popup's
    // state listener, which queries status again — an endless loop. Real
    // connection changes are broadcast by storageConnect / storageDisconnect.
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
    recordingRuntime.onRecordingComplete(sessionId);
  },
  getUploadArtifactChunk: (data) => getUploadArtifactChunk(getSessionArtifacts(), data),
  patchUploadProgress,
  submitFeedback,
  captureScreenshot: handleCaptureScreenshot,
  getPendingScreenshot: handleGetPendingScreenshot,
  discardPendingScreenshot: async () => {
    await clearPendingScreenshot();
    return { ok: true };
  },
  saveAnnotatedScreenshot: handleSaveAnnotatedScreenshot,
  captureInstantReplay: handleCaptureInstantReplay,
  handleInPageCaptureEntry: (message) => {
    const sessionId = typeof message.sessionId === "string" ? message.sessionId : "";
    const kind = typeof message.kind === "string" ? message.kind : "";
    const entry = message.entry;
    if (!sessionId || !kind || !entry || typeof entry !== "object") {
      return { ok: false, error: "Invalid in-page capture entry." };
    }
    recordingRuntime.ingestEvidenceEntry(sessionId, kind, entry as EvidenceEntry);
    return { ok: true };
  },
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
    // complete while keeping the recording alive. In-page console/network capture
    // is re-armed too: on Firefox it lives in content scripts that the navigation
    // destroyed, and leaving it dead produced recordings with empty console.json.
    void startRecordingEventCapture(tabId, activeRecording.sessionId);
    void startDrawingOverlay(tabId, activeRecording.sessionId);
    void recordingRuntime.reinjectEvidenceCapture(tabId, activeRecording.sessionId);
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
    // The replay must not imply the user did nothing: say the evidence is absent.
    addActivePrivacyLimitation(
      "User interactions were not captured because the extension lacks permission to run on this page.",
    );
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
      setActiveDrawingColor(color);
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

/**
 * Inject the recorded tab's content scripts while that tab still holds Firefox's
 * `activeTab` grant.
 *
 * `devlocal.example` style hosts match no entry in `host_permissions`, so on
 * Firefox the only access the extension has is `activeTab` — granted when the
 * user clicks the popup and **revoked as soon as another tab becomes active**.
 * The Firefox record path deliberately focuses the media host tab to obtain the
 * transient activation `getDisplayMedia` requires, which destroys that grant, so
 * every later `executeScript` fails with "Missing host permission for the tab".
 *
 * Injecting up front keeps user-event capture, DOM masking and the drawing
 * overlay working; the START messages that follow are plain tab messaging and
 * need no host permission. Re-injection after a navigation still needs a real
 * granted host permission.
 */
async function preinjectRecordedTabScripts(tabId: number): Promise<void> {
  await Promise.all(
    [RECORDING_EVENTS_SCRIPT, DRAWING_OVERLAY_SCRIPT].map(async (file) => {
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: [file] });
      } catch (error) {
        console.warn(`[GN Tracing] Could not pre-inject ${file}:`, error);
      }
    }),
  );
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
      color: getDrawingColor(),
    });
    await applyDrawingColorToOverlay(tabId, getDrawingColor());
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
    return {
      ok: true,
      active: activeRecording.drawingOverlayActive,
    } as MessageResponse;
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

async function getDrawingOverlayState(): Promise<
  MessageResponse & { active?: boolean; color?: string }
> {
  await drawingColorReady;
  if (!activeRecording.isRecording || activeRecording.tabId == null) {
    return { ok: true, active: false, color: getDrawingColor() };
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
      color: getDrawingColor(),
    };
  } catch (error) {
    return { ok: false, error: (error as Error).message, color: getDrawingColor() };
  }
}

async function setDrawingColor(
  data?: Record<string, unknown>,
): Promise<MessageResponse & { color?: string }> {
  await drawingColorReady;
  const color = normalizeDrawColor(data?.color);
  if (!color) {
    return {
      ok: false,
      error: "Invalid drawing color. Use a CSS hex value such as #ff6b6b.",
    };
  }

  setActiveDrawingColor(color);
  void persistDrawingColorPreference(color);

  if (activeRecording.isRecording && activeRecording.tabId != null) {
    await applyDrawingColorToOverlay(activeRecording.tabId, color);
  }

  return { ok: true, color };
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
  const { droppedPoints } = enforceDrawingBudgets(
    activeRecording.drawingStrokes,
    activeRecording.drawingClears,
  );
  if (droppedPoints) {
    addActivePrivacyLimitation(
      "Drawing capture reached the point budget; older strokes were dropped.",
    );
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
  enforceDrawingBudgets(activeRecording.drawingStrokes, activeRecording.drawingClears);

  return { ok: true };
}

function redactInPageNetworkEntry(entry: NetworkEntry): NetworkEntry {
  return applyInPageNetworkRedaction(
    entry,
    activeRecording.privacySettings,
    recordActiveRedactionHits,
  );
}

function redactInPageWebSocketEntry(entry: WebSocketEntry): WebSocketEntry {
  return applyInPageWebSocketRedaction(
    entry,
    activeRecording.privacySettings,
    recordActiveRedactionHits,
  );
}

function redactInPageStorageSnapshot(snapshot: StorageSnapshot): StorageSnapshot {
  return applyInPageStorageRedaction(snapshot, activeRecording.privacySettings, {
    redactStorageValues: activeRecording.recordingSettings?.redactStorageValues ?? true,
    onHits: recordActiveRedactionHits,
  });
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
        void recordingRuntime.captureDomSnapshotMarker("marker:navigation");
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

async function ensureMediaHost(): Promise<MessageResponse> {
  try {
    await recordingRuntime.ensurePackagingContext();
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not open the capture host page.",
    };
  }
}

async function startRecording(
  tabId: number,
  data?: Record<string, unknown>,
): Promise<MessageResponse> {
  if (activeRecording.isRecording) {
    return { ok: false, error: "Already recording" };
  }

  try {
    const settings = await getUploadSettings();
    const mediaPrearmed = data?.mediaPrearmed === true;
    const prearmedSessionId =
      typeof data?.sessionId === "string" && data.sessionId.trim() ? data.sessionId.trim() : null;
    const prearmedFirstFrameAt =
      typeof data?.firstFrameAt === "number" && Number.isFinite(data.firstFrameAt)
        ? data.firstFrameAt
        : null;
    const prearmedSurface =
      data?.capturedSurface && typeof data.capturedSurface === "object"
        ? (data.capturedSurface as { label?: string; displaySurface?: string })
        : undefined;

    const tab = await chrome.tabs.get(tabId);
    const target = getRecordingTabTarget(tab);
    if (target.error) {
      return { ok: false, error: target.error };
    }

    const sessionId = mediaPrearmed && prearmedSessionId ? prearmedSessionId : createSessionId();
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

    // Avoid double monkey-patch of console/fetch with always-on IR evidence.
    await pauseInstantReplayEvidence(tabId);

    storage.beginSession();
    storage.setCaptureSettings(settings);
    storage.setPrivacySettings(activeRecording.privacySettings, recordActiveRedactionHits);
    // Full recordings keep all evidence (no rolling Instant Replay retention).
    storage.setRollingWindowMs(null);

    // Inject before the runtime starts: the legacy Firefox arm path focuses the
    // media host tab (revoking activeTab). Prearmed popup capture never focuses
    // that tab, but pre-inject is still cheap insurance for evidence attach.
    await preinjectRecordedTabScripts(tabId);

    // Keepalive BEFORE the runtime starts, not after it returns.
    //
    // On Firefox the background is an event page (`background.scripts`), which
    // the browser unloads when idle and then re-evaluates from scratch. The
    // legacy arm path waits for the user to pick a share target — up to
    // ARM_TIMEOUT_MS (180s). Prearmed capture is shorter, but keepalive still
    // covers beginSession / packaging work after share commit.
    //
    // Chrome never showed this because its evidence arrives over CDP, whose
    // steady event traffic keeps the service worker alive on its own.
    chrome.alarms.create("gn-tracing-keepalive", { periodInMinutes: 0.4 });

    const { firstFrameAt } = await recordingRuntime.start({
      tabId,
      sessionId,
      settings,
      privacySettings: activeRecording.privacySettings,
      onRedactionHits: recordActiveRedactionHits,
      mediaPrearmed,
      firstFrameAt: prearmedFirstFrameAt,
      capturedSurface: prearmedSurface,
    });

    // Anchor the timeline at the first produced video frame when available;
    // fall back to the startCapture acknowledgement time. Duration uses this
    // same wall origin (`getElapsedMs(stopTime)`), not a later SW clock.
    activeRecording.startTime = firstFrameAt ?? Date.now();
    activeRecording.isRecording = true;
    recordingRuntime.hydrateActiveSession(sessionId);
    void startRecordingEventCapture(tabId, sessionId, activeRecording.privacySettings);
    void startDrawingOverlay(tabId, sessionId);

    chrome.action.setBadgeText({ text: "REC" });
    chrome.action.setBadgeBackgroundColor({ color: "#ef233c" });

    await saveStateToStorage();
    return { ok: true };
  } catch (error) {
    // The keepalive is armed before the start path waits for the user, so it
    // must be cleared on every failure path or a cancelled start leaves the
    // event page being woken every 24s forever.
    chrome.alarms.clear("gn-tracing-keepalive");
    await stopRecordingEventCapture(tabId);
    try {
      await recordingRuntime.discard();
    } catch {
      // Ignore recorder cleanup failures.
    }
    resetActiveRecordingState();
    storage.beginSession();
    // Pause ran before attach/startCapture; always resume IR evidence on failure
    // so always-on lookback is not stuck until the tab reloads.
    await resumeInstantReplayEvidence(tabId);
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
  const recordingTabId = activeRecording.tabId;

  try {
    activeRecording.isRecording = false;
    activeRecording.stopTime = stopTime;

    await stopDrawingOverlay(activeRecording.tabId);
    await stopRecordingEventCapture(activeRecording.tabId);
    // Stop media first so video length matches the user's stop, then finalize
    // evidence (source maps / detach) inside the browser runtime.
    await recordingRuntime.stopMedia();
    const screenshotDataUrl = await captureVisibleTabScreenshot(activeRecording.tabId);

    const evidenceFinal = await recordingRuntime.finalizeEvidence({
      captureStorage: Boolean(activeRecording.recordingSettings?.captureStorage),
      captureDomSnapshots: Boolean(activeRecording.recordingSettings?.captureDomSnapshots),
      stopTime,
    });
    for (const limitation of evidenceFinal.privacyLimitations) {
      addActivePrivacyLimitation(limitation);
    }
    const sourceMapDiagnostics: SourceMapDiagnosticsArtifact | null =
      evidenceFinal.sourceMapDiagnostics;

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

    const durationMs = getElapsedMs(stopTime);

    getSessionArtifacts()[sessionId] = {
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
      duration: durationMs,
      url: tabUrl || "",
      startTime,
      stopTime,
    };

    const sessionSummary: RecordingSessionSummary = {
      id: sessionId,
      phase: "recorded",
      startTime,
      stopTime,
      elapsedMs: durationMs,
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

    setIdleBadge();
    chrome.alarms.clear("gn-tracing-keepalive");

    resetActiveRecordingState();
    await saveArtifactsToStorage();
    await saveStateToStorage();
    await resumeInstantReplayEvidence(recordingTabId);

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
    await resumeInstantReplayEvidence(recordingTabId);
    await saveStateToStorage();
    return { ok: false, error: (error as Error).message };
  }
}

async function removeRecording(): Promise<MessageResponse> {
  if (!activeRecording.isRecording || !activeRecording.sessionId) {
    return { ok: false, error: "No active recording to remove." };
  }

  const sessionId = activeRecording.sessionId;
  const recordingTabId = activeRecording.tabId;

  try {
    activeRecording.isRecording = false;

    await stopDrawingOverlay(activeRecording.tabId);
    await stopRecordingEventCapture(activeRecording.tabId);
    await recordingRuntime.discard();

    storage.clear();
    recordingRuntime.releaseSourceMaps();
    activeRecording.drawingStrokes = [];
    activeRecording.drawingOverlayActive = false;
    delete getSessionArtifacts()[sessionId];

    setIdleBadge();
    chrome.alarms.clear("gn-tracing-keepalive");

    resetActiveRecordingState();
    await saveArtifactsToStorage();
    await saveStateToStorage();
    await resumeInstantReplayEvidence(recordingTabId);

    void chrome.runtime
      .sendMessage({
        target: getMediaMessageTarget(),
        type: "DELETE_SESSION_SNAPSHOT",
        data: { sessionId },
      })
      .catch(() => {});

    return { ok: true };
  } catch (error) {
    resetActiveRecordingState();
    storage.clear();
    recordingRuntime.releaseSourceMaps();
    await saveArtifactsToStorage();
    await saveStateToStorage();
    // Discard may have paused IR via an earlier successful start; resume even
    // when teardown throws so evidence is not left permanently paused.
    await resumeInstantReplayEvidence(recordingTabId);
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
  return {
    ok: true,
    state: popupState || undefined,
    uploadHistory: nextHistory,
  };
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

  setSessions(getSessions().filter((session) => session.id !== sessionId));
  delete getSessionArtifacts()[sessionId];

  await saveArtifactsToStorage();
  await saveStateToStorage();

  void chrome.runtime
    .sendMessage({
      target: getMediaMessageTarget(),
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

  // Field-level merge only — capture/privacy profile presets are retired.
  const nextCaptureResponseBodyMode = normalizeEnum<ResponseBodyCaptureMode>(
    data?.captureResponseBodyMode,
    ["off", "text", "text-json", "eligible"],
    existingSettings.captureResponseBodies ? existingSettings.captureResponseBodyMode : "off",
  );
  const nextCaptureResponseBodies =
    typeof data?.captureResponseBodies === "boolean"
      ? data.captureResponseBodies
      : Object.hasOwn(data || {}, "captureResponseBodyMode")
        ? nextCaptureResponseBodyMode !== "off"
        : existingSettings.captureResponseBodies;

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
    microphoneDeviceId:
      typeof data?.microphoneDeviceId === "string"
        ? data.microphoneDeviceId.trim()
        : existingSettings.microphoneDeviceId,
    speakerDeviceId:
      typeof data?.speakerDeviceId === "string"
        ? data.speakerDeviceId.trim()
        : existingSettings.speakerDeviceId,
    // Non-UI fixed profile for redaction rule membership + privacy.json.
    privacyProfile: "custom",
    redactSensitiveHeaders: normalizeBoolean(
      data?.redactSensitiveHeaders,
      existingSettings.redactSensitiveHeaders,
    ),
    redactSensitiveQueryParams: normalizeBoolean(
      data?.redactSensitiveQueryParams,
      existingSettings.redactSensitiveQueryParams,
    ),
    redactRequestBodyFields: normalizeBoolean(
      data?.redactRequestBodyFields,
      existingSettings.redactRequestBodyFields,
    ),
    redactResponseBodyFields: normalizeBoolean(
      data?.redactResponseBodyFields,
      existingSettings.redactResponseBodyFields,
    ),
    redactConsoleValues: normalizeBoolean(
      data?.redactConsoleValues,
      existingSettings.redactConsoleValues,
    ),
    redactWebSocketPayloads: normalizeEnum(
      data?.redactWebSocketPayloads,
      ["off", "sensitive-fields", "all"],
      existingSettings.redactWebSocketPayloads,
    ),
    redactEventMetadata: normalizeBoolean(
      data?.redactEventMetadata,
      existingSettings.redactEventMetadata,
    ),
    maskDomSelectors: normalizeMaskDomSelectors(
      Object.hasOwn(data || {}, "maskDomSelectors")
        ? data?.maskDomSelectors
        : existingSettings.maskDomSelectors,
    ),
    captureConsole: normalizeBoolean(data?.captureConsole, existingSettings.captureConsole),
    captureConsoleArgs: normalizeBoolean(
      data?.captureConsoleArgs,
      existingSettings.captureConsoleArgs,
    ),
    consolePreviewDepth: normalizeEnum<ConsolePreviewDepth>(
      data?.consolePreviewDepth,
      ["none", "shallow", "full"],
      existingSettings.consolePreviewDepth,
    ),
    captureConsoleStacks: normalizeEnum<ConsoleStackMode>(
      data?.captureConsoleStacks,
      ["off", "errors", "warnings-errors", "all"],
      existingSettings.captureConsoleStacks,
    ),
    captureConsoleSourceSnippets: normalizeEnum<ConsoleSourceSnippetMode>(
      data?.captureConsoleSourceSnippets,
      ["off", "errors", "warnings-errors", "all"],
      existingSettings.captureConsoleSourceSnippets,
    ),
    maxConsoleEntryBytes: normalizeOptionalNumber(
      data?.maxConsoleEntryBytes,
      existingSettings.maxConsoleEntryBytes,
      1024,
      512 * 1024,
    ),
    captureNetwork: normalizeBoolean(data?.captureNetwork, existingSettings.captureNetwork),
    captureRequestHeaders: normalizeEnum<HeaderCaptureMode>(
      data?.captureRequestHeaders,
      ["off", "minimal", "full"],
      existingSettings.captureRequestHeaders,
    ),
    captureResponseHeaders: normalizeEnum<HeaderCaptureMode>(
      data?.captureResponseHeaders,
      ["off", "minimal", "full"],
      existingSettings.captureResponseHeaders,
    ),
    captureRequestBodies: normalizeBoolean(
      data?.captureRequestBodies,
      existingSettings.captureRequestBodies,
    ),
    captureResponseBodies: nextCaptureResponseBodies,
    captureResponseBodyMode: nextCaptureResponseBodies ? nextCaptureResponseBodyMode : "off",
    maxResponseBodyBytes: normalizeOptionalNumber(
      data?.maxResponseBodyBytes,
      existingSettings.maxResponseBodyBytes,
      0,
      10 * 1024 * 1024,
    ),
    captureRedirectHeaders: normalizeEnum<RedirectHeaderCaptureMode>(
      data?.captureRedirectHeaders,
      ["off", "location", "full"],
      existingSettings.captureRedirectHeaders,
    ),
    captureInitiator: normalizeEnum<InitiatorCaptureMode>(
      data?.captureInitiator,
      ["off", "summary", "short-stack", "full-stack"],
      existingSettings.captureInitiator,
    ),
    suppressRecorderInternalRequests: normalizeBoolean(
      data?.suppressRecorderInternalRequests,
      existingSettings.suppressRecorderInternalRequests,
    ),
    captureWebSockets: normalizeBoolean(
      data?.captureWebSockets,
      existingSettings.captureWebSockets,
    ),
    captureWebSocketFrames: normalizeBoolean(
      data?.captureWebSocketFrames,
      existingSettings.captureWebSocketFrames,
    ),
    maxWebSocketFrameBytes: normalizeOptionalNumber(
      data?.maxWebSocketFrameBytes,
      existingSettings.maxWebSocketFrameBytes,
      0,
      1024 * 1024,
    ),
    captureWebSocketInitiator: normalizeBoolean(
      data?.captureWebSocketInitiator,
      existingSettings.captureWebSocketInitiator,
    ),
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
    instantReplayEnabled: normalizeBoolean(
      data?.instantReplayEnabled,
      existingSettings.instantReplayEnabled,
    ),
    instantReplayWindowSeconds: normalizeInstantReplayWindowSeconds(
      Object.hasOwn(data || {}, "instantReplayWindowSeconds")
        ? data?.instantReplayWindowSeconds
        : existingSettings.instantReplayWindowSeconds,
      existingSettings.instantReplayWindowSeconds,
    ),
    instantReplayAllowedDomains: normalizeInstantReplayAllowedDomains(
      Object.hasOwn(data || {}, "instantReplayAllowedDomains")
        ? data?.instantReplayAllowedDomains
        : existingSettings.instantReplayAllowedDomains,
    ),
    // Legacy `captureMode` in UPDATE_SETTINGS payloads is ignored (CDP-only).
  };
  // Coupling (product rule): enabling network/request capture also forces
  // storage and DOM snapshot capture on. Redaction toggles are left intact.
  if (settings.captureNetwork) {
    settings.captureStorage = true;
    settings.captureDomSnapshots = true;
  }

  // Instant Replay is a permission decision: sync registration before we claim
  // the setting is on. Refusal keeps the feature off.
  const irSettingsChanged =
    Object.hasOwn(data || {}, "instantReplayEnabled") ||
    Object.hasOwn(data || {}, "instantReplayWindowSeconds") ||
    Object.hasOwn(data || {}, "instantReplayAllowedDomains") ||
    settings.instantReplayEnabled !== existingSettings.instantReplayEnabled;

  if (
    Object.hasOwn(data || {}, "instantReplayEnabled") ||
    settings.instantReplayEnabled !== existingSettings.instantReplayEnabled
  ) {
    const registration = await syncInstantReplayRegistration(
      settings.instantReplayEnabled,
      createRegistrationDeps(),
    );
    if (!registration.ok) {
      settings.instantReplayEnabled = false;
      await saveUploadSettings(settings);
      await saveStateToStorage();
      return {
        ok: false,
        error: registration.error,
        settings: getSettingsSnapshot(settings),
      };
    }
    settings.instantReplayEnabled = registration.enabled;
  } else if (settings.instantReplayEnabled) {
    // Window/allowlist change while enabled: keep registration in sync.
    const registration = await syncInstantReplayRegistration(true, createRegistrationDeps());
    if (!registration.ok) {
      settings.instantReplayEnabled = false;
      await saveUploadSettings(settings);
      await saveStateToStorage();
      return {
        ok: false,
        error: registration.error,
        settings: getSettingsSnapshot(settings),
      };
    }
  }

  await saveUploadSettings(settings);
  await saveStateToStorage();

  if (irSettingsChanged || settings.instantReplayEnabled) {
    await irCdpHub.sync().catch((error) => {
      console.warn("[GN Tracing] Instant Replay CDP sync failed:", error);
    });
  }

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
      : getSessions().find(
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
  const artifacts = getSessionArtifacts()[sessionId];

  if (!session || !artifacts || !session.hasLocalSnapshot) {
    // Three distinct causes; naming the right one is the difference between a
    // user retrying usefully and filing a bug about a lost recording.
    const error = !session
      ? "This recording is no longer tracked by the extension."
      : !artifacts
        ? "The recording's evidence was lost when the extension runtime restarted. Record again."
        : "Recording snapshot is no longer available for upload.";
    patchSession(sessionId, {
      phase: "failed",
      error,
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
      target: getMediaMessageTarget(),
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

    delete getSessionArtifacts()[sessionId];
    await saveArtifactsToStorage();

    await chrome.runtime
      .sendMessage({
        target: getMediaMessageTarget(),
        type: "DELETE_SESSION_SNAPSHOT",
        data: { sessionId },
      })
      .catch(() => {});
    await closeMediaHostIfIdle();

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

// ===== Instant Replay (DOM content script + CDP on allowlisted tabs) =====

/**
 * Pulls DOM frames from the content script and console/network rings from the
 * IR CDP hub (non-destructive).
 */
async function collectInstantReplay(tabId: number | undefined) {
  if (typeof tabId !== "number") {
    return parseCollectInstantReplayResponse(undefined);
  }
  let collected: CollectInstantReplayResult;
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      action: COLLECT_INSTANT_REPLAY_ACTION,
    });
    collected = parseCollectInstantReplayResponse(response);
  } catch {
    collected = parseCollectInstantReplayResponse(undefined);
  }

  if (!collected.ok) {
    return collected;
  }

  // CDP rings when the hub is attached to this tab (allowlisted + focused).
  const hubEvidence = irCdpHub.isAttachedTo(tabId) ? irCdpHub.peekEvidenceBundle() : null;

  return {
    ...collected,
    evidence: hubEvidence ?? collected.evidence,
  };
}

/** Clear DOM buffer + CDP rings after a successful IR package upload. */
async function commitInstantReplay(tabId: number | undefined): Promise<void> {
  if (typeof tabId === "number") {
    try {
      await chrome.tabs.sendMessage(tabId, {
        action: COMMIT_INSTANT_REPLAY_ACTION,
      });
    } catch {
      // Tab may have navigated; nothing left to clear.
    }
  }
  if (typeof tabId === "number" && irCdpHub.isAttachedTo(tabId)) {
    irCdpHub.clearBuffersAfterCommit();
  }
}

/** Record takes the debugger — detach IR CDP first (Chromium only). */
async function pauseInstantReplayEvidence(tabId: number | null): Promise<void> {
  await irCdpHub.pauseForRecording(tabId);
}

/** After Record stops, re-attach IR CDP if allowlist still matches. */
async function resumeInstantReplayEvidence(_tabId: number | null): Promise<void> {
  await irCdpHub.resumeAfterRecording();
}

/**
 * Persist a screenshot / Instant Replay upload into local history (same family
 * as a normal recording upload outcome).
 */
async function persistReportUploadHistory(input: {
  recordingUrl: string;
  pageUrl?: string;
  indexFileId?: string | null;
  targetFolderId?: string | null;
  durationMs?: number;
  provider: StorageProviderId;
}): Promise<void> {
  const recordingUrl = normalizeRecordingUrl(input.recordingUrl);
  if (!recordingUrl) {
    return;
  }
  const entry = buildReportUploadHistoryEntry({
    ...input,
    recordingUrl,
  });
  const history = [entry, ...(await getUploadHistory())].slice(0, MAX_UPLOAD_HISTORY_ITEMS);
  await saveUploadHistory(history);
  notifyPopupStateUpdated(await saveStateToStorage());
}

/**
 * Shared chrome.* deps for annotate capture (Screenshot and Instant Replay).
 * IR only customizes finalizePending to freeze lookback into the parked kind.
 */
function createAnnotateCaptureDeps(
  overrides: Partial<{
    finalizePending: NonNullable<
      Parameters<typeof captureScreenshotForAnnotation>[1]["finalizePending"]
    >;
  }> = {},
): Parameters<typeof captureScreenshotForAnnotation>[1] {
  return {
    captureVisibleTab: (windowId) =>
      chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 85 }),
    getTab: (id) => chrome.tabs.get(id),
    getViewport: async (id) => {
      // The image is device-pixel sized; annotations are placed in CSS pixels,
      // so the page's own measurements are what the editor needs.
      const [injected] = await chrome.scripting.executeScript({
        target: { tabId: id },
        func: () => ({
          width: window.innerWidth,
          height: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio,
        }),
      });
      return (injected?.result as { width: number; height: number } | undefined) ?? null;
    },
    setPending: writePendingScreenshot,
    openEditor: openAnnotateEditorTab,
    ...overrides,
  };
}

/**
 * Instant Replay capture: freeze the lookback, capture a still for annotation,
 * open the editor. Upload happens only after Save on the annotate page.
 * Does not start MediaRecorder (CDP may already be attached for IR evidence).
 */
async function handleCaptureInstantReplay(tabId: number | undefined): Promise<MessageResponse> {
  const settings = await getUploadSettings();
  if (!settings.instantReplayEnabled) {
    return {
      ok: false,
      error:
        "Instant Replay is off. Enable it in the popup, add an allowed domain, then browse a bit before capturing.",
    };
  }
  if (!settings.instantReplayAllowedDomains || settings.instantReplayAllowedDomains.length === 0) {
    return {
      ok: false,
      error: "Add at least one allowed domain for Instant Replay, open that site, then capture.",
    };
  }

  const targetTabId =
    typeof tabId === "number"
      ? tabId
      : (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;

  if (typeof targetTabId !== "number") {
    return {
      ok: false,
      error: "Open a browser tab before capturing Instant Replay.",
    };
  }

  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(targetTabId);
  } catch (error) {
    return {
      ok: false,
      error: `Could not read the active tab: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const target = getRecordingTabTarget(tab);
  if (target.error) {
    return { ok: false, error: target.error };
  }

  if (
    !tabUrlMatchesInstantReplayAllowlist(
      target.url ?? tab.url,
      settings.instantReplayAllowedDomains,
    )
  ) {
    return {
      ok: false,
      error:
        "This tab's domain is not on the Instant Replay allowlist. Add the site in Instant Replay settings, then capture again.",
    };
  }

  // Freeze lookback before opening the editor so annotation time does not
  // change which DOM/console/network rings ship with the package.
  const collected = await collectInstantReplay(targetTabId);
  if (!collected.ok) {
    return { ok: false, error: collected.error };
  }

  const result = await captureScreenshotForAnnotation(
    targetTabId,
    createAnnotateCaptureDeps({
      finalizePending: (base) =>
        buildInstantReplayPending(
          base,
          { artifact: collected.artifact, evidence: collected.evidence },
          { url: target.url ?? base.url },
        ),
    }),
  );

  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

// ===== Screenshot reports =====
//
// Still + one-shot DOM (`dom.json`). No video, no Instant Replay lookback, no
// console/network — those belong to Instant Replay capture and full Record.

async function captureTabDomSnapshot(tabId: number): Promise<DomSnapshot | null> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/page-dom-snapshot.js"],
    });
    const response = (await chrome.tabs.sendMessage(tabId, {
      action: CAPTURE_PAGE_DOM_SNAPSHOT_ACTION,
    })) as {
      ok?: boolean;
      snapshot?: DomSnapshot;
    };
    if (response?.ok && response.snapshot?.root) {
      return response.snapshot;
    }
  } catch {
    // Restricted pages (chrome://, Web Store) cannot inject — still ships.
  }
  return null;
}

async function handleCaptureScreenshot(tabId: number | undefined): Promise<MessageResponse> {
  const targetTabId =
    typeof tabId === "number"
      ? tabId
      : (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;

  if (typeof targetTabId !== "number") {
    return {
      ok: false,
      error: "Open a browser tab before capturing a screenshot.",
    };
  }

  const result = await captureScreenshotForAnnotation(
    targetTabId,
    createAnnotateCaptureDeps({
      finalizePending: async (base) => {
        const frozenDom = await captureTabDomSnapshot(base.tabId);
        return {
          ...base,
          kind: "screenshot",
          frozenDom: frozenDom ?? undefined,
        };
      },
    }),
  );
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

async function handleGetPendingScreenshot(): Promise<
  MessageResponse & { screenshot?: Awaited<ReturnType<typeof readPendingStillForAnnotate>> }
> {
  // Read still only — do not reassemble IR freeze. A large/corrupt freeze must
  // not blank the editor image (freeze is loaded again on Save).
  const still = await readPendingStillForAnnotate();
  if (!still) {
    return { ok: false, error: "No screenshot is waiting to be annotated." };
  }
  return { ok: true, screenshot: still };
}

async function handleSaveAnnotatedScreenshot(
  data: Record<string, unknown> | undefined,
): Promise<MessageResponse> {
  const pending = await readPendingScreenshot();
  if (!pending) {
    return { ok: false, error: "This screenshot is no longer available." };
  }

  const annotated = data?.screenshot as Screenshot | undefined;
  if (!annotated || typeof annotated !== "object") {
    return { ok: false, error: "No annotations were supplied." };
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

  const storageProviderId = resolveRegisteredUploadProviderId(settings.activeStorageProvider);
  const targetFolderId =
    storageProviderId === "dropbox"
      ? settings.folderPath.length > 0
        ? `/${settings.folderPath.join("/")}`
        : null
      : settings.folderId;

  const merged = mergeAnnotatedScreenshot(pending, annotated);
  // Instant Replay: freeze + evidence. Screenshot: optional one-shot DOM only.
  const irResolution = await resolveInstantReplayForSave(pending);

  if (irResolution.mode === "error") {
    return { ok: false, error: irResolution.error };
  }

  const isInstantReplayReport = isInstantReplayPending(pending);
  let screenshotArtifacts: Record<string, string> = {};
  let attachedCoveredMs = 0;
  if (irResolution.mode === "attach") {
    const privacySettings = pickPrivacyRedactionSettings(settings);
    const previousPrivacy = activeRecording.privacySettings;
    const previousRecordingSettings = activeRecording.recordingSettings;
    activeRecording.privacySettings = privacySettings;
    activeRecording.recordingSettings = settings;
    screenshotArtifacts = buildInstantReplayPackageArtifacts({
      instantReplayJson: JSON.stringify(irResolution.artifact),
      evidence: irResolution.evidence,
      privacySettings,
      redact: {
        network: (entry) => redactInPageNetworkEntry({ ...entry }),
        websocket: (entry) =>
          redactInPageWebSocketEntry({
            ...entry,
            frames: entry.frames.map((frame) => ({ ...frame })),
          }),
        storage: (snapshot) =>
          redactInPageStorageSnapshot({
            ...snapshot,
            localStorage: snapshot.localStorage.map((item) => ({ ...item })),
            sessionStorage: snapshot.sessionStorage.map((item) => ({
              ...item,
            })),
            cookies: snapshot.cookies.map((cookie) => ({ ...cookie })),
          }),
      },
    });
    activeRecording.privacySettings = previousPrivacy;
    activeRecording.recordingSettings = previousRecordingSettings;
    attachedCoveredMs =
      typeof irResolution.artifact.coveredMs === "number" ? irResolution.artifact.coveredMs : 0;
  } else if (pending.kind === "screenshot" && pending.frozenDom?.root) {
    screenshotArtifacts = {
      dom: JSON.stringify({
        schemaVersion: 1,
        snapshots: [pending.frozenDom],
      }),
    };
  }

  // Bulk still + IR JSON in IndexedDB (shared with offscreen origin). Message
  // only carries stagingId — chrome.runtime.sendMessage rejects ~64MiB bodies.
  const stagingId = `annotate-${pending.id}-${Date.now()}`;
  try {
    await putScreenshotPackageStaging(stagingId, {
      imageDataUrl: merged.imageDataUrl,
      artifacts: screenshotArtifacts as Record<string, string>,
    });
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Could not stage Instant Replay package for upload.",
    };
  }

  try {
    await recordingRuntime.ensurePackagingContext();
    const result = (await chrome.runtime.sendMessage({
      target: getMediaMessageTarget(),
      type: "UPLOAD_SCREENSHOT_PACKAGE",
      data: {
        stagingId,
        authToken,
        storageProvider: storageProviderId,
        targetFolderId,
        targetFolderPath: settings.folderPath,
        zipPassword: settings.zipPassword || null,
        url: merged.screenshot.url,
        // Still + artifacts stay in IDB; only annotation metadata crosses the channel.
        screenshots: [{ screenshot: merged.screenshot }],
        // Capabilities + console strip depend on product path, not artifact presence.
        packageKind: isInstantReplayReport ? "instant-replay" : "screenshot",
      },
    })) as MessageResponse & Partial<UploadSuccessResult>;

    if (!result?.ok) {
      return {
        ok: false,
        error:
          result?.error ||
          (isInstantReplayPending(pending)
            ? "Instant Replay upload failed."
            : "Screenshot upload failed."),
      };
    }

    // Commit IR buffer only after a successful upload (collect is non-destructive).
    if (screenshotArtifacts.instantReplay) {
      await commitInstantReplay(pending.tabId);
    }

    // The capture is a picture of the user's screen; it has no reason to
    // outlive the report it belongs to.
    await clearPendingScreenshot();
    await closeMediaHostIfIdle();

    const recordingUrl = normalizeRecordingUrl(result.recordingUrl) ?? undefined;
    if (recordingUrl) {
      await persistReportUploadHistory({
        recordingUrl,
        pageUrl: merged.screenshot.url,
        indexFileId: result.indexFileId ?? null,
        targetFolderId: result.targetFolderId ?? targetFolderId,
        durationMs: attachedCoveredMs,
        provider: storageProviderId,
      });
    }

    return {
      ok: true,
      recordingUrl,
    };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  } finally {
    await clearScreenshotPackageStaging(stagingId).catch(() => undefined);
  }
}
