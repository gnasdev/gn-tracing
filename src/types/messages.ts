/**
 * Message contracts shared between extension UIs, service worker, and offscreen runtime.
 */
// Privacy settings live in the shared schema so the extension and the browser
// SDK feed the same redaction policy. Re-exported below for existing importers.
import type {
  PrivacyProfile,
  PrivacyRedactionSettings,
  WebSocketPayloadRedactionMode,
} from "../../packages/replay-core/src/schema/privacy";
import type { StorageProviderId } from "../shared/storage-provider";

export type { PrivacyProfile, PrivacyRedactionSettings, WebSocketPayloadRedactionMode };

type MessageAction =
  | "START_RECORDING"
  | "STOP_RECORDING"
  | "REMOVE_RECORDING"
  | "GET_STATUS"
  | "GET_SETTINGS"
  | "UPDATE_SETTINGS"
  | "DELETE_UPLOAD_HISTORY_ENTRY"
  | "DELETE_SESSION"
  | "RECORDING_USER_EVENT"
  | "RECORDING_DRAW_STROKE"
  | "RECORDING_DRAW_CLEAR"
  | "TOGGLE_DRAWING_OVERLAY"
  | "GET_DRAWING_OVERLAY_STATE"
  | "SET_DRAWING_COLOR"
  // Generic multi-cloud storage messages (preferred).
  | "STORAGE_CONNECT"
  | "STORAGE_DISCONNECT"
  | "STORAGE_STATUS"
  | "GET_STORAGE_TOKEN"
  // Legacy Google Drive aliases — map to google-drive in the message router.
  | "GOOGLE_DRIVE_CONNECT"
  | "GOOGLE_DRIVE_DISCONNECT"
  | "GOOGLE_DRIVE_STATUS"
  | "GET_GOOGLE_DRIVE_TOKEN"
  | "UPLOAD_TO_GOOGLE_DRIVE"
  | "RECORDING_COMPLETE"
  | "GET_UPLOAD_ARTIFACT_CHUNK"
  | "GET_UPLOAD_STATE"
  | "SUBMIT_FEEDBACK"
  // Screenshot reports: capture, annotate in a page, package without video.
  | "CAPTURE_SCREENSHOT"
  | "GET_PENDING_SCREENSHOT"
  | "DISCARD_PENDING_SCREENSHOT"
  | "SAVE_ANNOTATED_SCREENSHOT"
  /** Collect always-on Instant Replay buffer on the active tab and upload. */
  | "CAPTURE_INSTANT_REPLAY"
  /** Firefox in-page capture bridge → storage (MAIN world evidence). */
  | "IN_PAGE_CAPTURE_ENTRY"
  /** Firefox: open parked media host tab without focusing (popup stream handoff). */
  | "ENSURE_MEDIA_HOST";

type RecordingPhase = "idle" | "recording" | "interrupted";

type RecordingSessionPhase = "recorded" | "uploading" | "uploaded" | "failed";

export interface ServiceWorkerMessage {
  action: MessageAction;
  target?: string;
  tabId?: number;
  url?: string;
  data?: Record<string, unknown>;
  /** IN_PAGE_CAPTURE_ENTRY: session that produced the entry. */
  sessionId?: string;
  /** IN_PAGE_CAPTURE_ENTRY: console | network | websocket | storage. */
  kind?: string;
  /** IN_PAGE_CAPTURE_ENTRY: captured payload. */
  entry?: unknown;
}

/**
 * Runtime message and UI-state contracts shared by popup, service worker,
 * offscreen document, auth page, and history page.
 *
 * These types describe data crossing Chrome runtime message/storage boundaries,
 * so changes should be made with every sender and receiver in mind.
 */
export interface MessageResponse {
  ok: boolean;
  error?: string;
  message?: string;
  url?: string;
  recordingUrl?: string;
  token?: string | null;
  /** Present on STORAGE_STATUS / GOOGLE_DRIVE_STATUS responses. */
  isConnected?: boolean;
  /** Present on SUBMIT_FEEDBACK success when the Worker created a GitHub issue. */
  issueUrl?: string;
  issueNumber?: number;
}

export type ProgressItemStatus =
  | "queued"
  | "uploading"
  | "uploaded"
  | "loading"
  | "loaded"
  | "skipped"
  | "failed";

export interface ProgressItemSnapshot {
  key: string;
  label: string;
  status: ProgressItemStatus;
  loadedBytes: number;
  totalBytes: number;
  percent: number;
}

export interface RecordingStatus {
  phase: RecordingPhase;
  sessionId: string | null;
  isRecording: boolean;
  tabId: number | null;
  startTime: number | null;
  stopTime?: number | null;
  tabUrl?: string | null;
  elapsedMs: number;
  elapsedUpdatedAt: number;
  consoleLogCount: number;
  networkRequestCount: number;
}

export interface RecordingSessionSummary {
  id: string;
  phase: RecordingSessionPhase;
  startTime: number | null;
  stopTime: number | null;
  elapsedMs: number;
  tabUrl: string | null;
  consoleLogCount: number;
  networkRequestCount: number;
  hasLocalSnapshot: boolean;
  progress: number;
  uploadedBytes: number;
  totalBytes: number;
  message: string;
  items: ProgressItemSnapshot[];
  recordingUrl: string | null;
  recordingFolderId: string | null;
  indexFileId: string | null;
  error: string | null;
}

export interface UploadSettings {
  /** Active cloud storage provider for connect/upload (default google-drive). */
  activeStorageProvider: StorageProviderId;
  folderInput: string;
  folderId: string | null;
  zipPasswordConfigured: boolean;
  /** Fixed non-UI value for redaction engine / privacy.json (always "custom" after migrate). */
  privacyProfile: PrivacyProfile;
  redactSensitiveHeaders: boolean;
  redactSensitiveQueryParams: boolean;
  redactRequestBodyFields: boolean;
  redactResponseBodyFields: boolean;
  redactConsoleValues: boolean;
  redactWebSocketPayloads: WebSocketPayloadRedactionMode;
  redactEventMetadata: boolean;
  maskDomSelectors: string[];
  captureConsole: boolean;
  captureConsoleArgs: boolean;
  consolePreviewDepth: ConsolePreviewDepth;
  captureConsoleStacks: ConsoleStackMode;
  captureConsoleSourceSnippets: ConsoleSourceSnippetMode;
  maxConsoleEntryBytes: number | null;
  captureNetwork: boolean;
  captureRequestHeaders: HeaderCaptureMode;
  captureResponseHeaders: HeaderCaptureMode;
  captureRequestBodies: boolean;
  captureResponseBodies: boolean;
  captureResponseBodyMode: ResponseBodyCaptureMode;
  maxResponseBodyBytes: number | null;
  captureRedirectHeaders: RedirectHeaderCaptureMode;
  captureInitiator: InitiatorCaptureMode;
  suppressRecorderInternalRequests: boolean;
  captureWebSockets: boolean;
  captureWebSocketFrames: boolean;
  maxWebSocketFrameBytes: number | null;
  captureWebSocketInitiator: boolean;
  // Inspector capture toggles (privacy-first: capture OFF, redact ON by default).
  captureStorage: boolean;
  redactStorageValues: boolean;
  captureDomSnapshots: boolean;
  redactDomTextContent: boolean;
  /**
   * Always-on Instant Replay: rolling DOM lookback via content script + CDP
   * console/network on allowlisted hosts. Off by default; enabling requests
   * optional host permission.
   */
  instantReplayEnabled: boolean;
  /**
   * Rolling lookback window for Instant Replay (seconds).
   * Default 120; clamped to 15–300 in the settings store.
   */
  instantReplayWindowSeconds: number;
  /**
   * Host patterns where Instant Replay may attach chrome.debugger (CDP).
   * Empty = no CDP attach (safe default). Supports `*.example.com`.
   */
  instantReplayAllowedDomains: string[];
}

export type ConsolePreviewDepth = "none" | "shallow" | "full";
export type ConsoleStackMode = "off" | "errors" | "warnings-errors" | "all";
export type ConsoleSourceSnippetMode = "off" | "errors" | "warnings-errors" | "all";
export type HeaderCaptureMode = "off" | "minimal" | "full";
export type ResponseBodyCaptureMode = "off" | "text" | "text-json" | "eligible";
export type RedirectHeaderCaptureMode = "off" | "location" | "full";
export type InitiatorCaptureMode = "off" | "summary" | "short-stack" | "full-stack";

export interface UploadHistoryEntry {
  id: string;
  uploadedAt: number;
  pageUrl: string;
  recordingUrl: string;
  recordingFolderId: string | null;
  targetFolderId: string | null;
  durationMs: number;
  /** Provider used for this upload; omitted on legacy history entries. */
  provider?: StorageProviderId;
}

export interface PopupState {
  recording: RecordingStatus | null;
  sessions: RecordingSessionSummary[];
  /**
   * Generic storage connection snapshot for the active provider.
   * Prefer this over `googleDrive` for new UI; `googleDrive` remains as a
   * one-release shim mirroring Google Drive connection state.
   */
  storage: {
    provider: StorageProviderId;
    isConnected: boolean;
  };
  /** @deprecated Prefer `storage`; kept for existing popup state consumers. */
  googleDrive: {
    isConnected: boolean;
  };
  settings: UploadSettings;
  uploadHistory: UploadHistoryEntry[];
}
