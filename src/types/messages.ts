/**
 * Message contracts shared between extension UIs, service worker, and offscreen runtime.
 */
import type { StorageProviderId } from "../shared/storage-provider";
import type { ConsoleEntry, NetworkEntry, StorageSnapshot, WebSocketEntry } from "./recording";

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
  | "RECORDING_INPAGE_ENTRY"
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
  | "SUBMIT_FEEDBACK";

/**
 * In-page (MAIN world) capture protocol.
 *
 * In `captureMode === "in-page"` the service worker injects a MAIN-world
 * instrumentation script that cannot reach `chrome.runtime` directly. It posts
 * tagged `window.postMessage` events that an ISOLATED-world relay forwards to
 * the service worker as `RECORDING_INPAGE_ENTRY` messages. The captured payload
 * reuses the same artifact schemas the player already reads, so the player does
 * not need to know the capture source (Requirement R9.3).
 */
export type InPageCaptureKind = "console" | "network" | "websocket" | "storage";

export type InPageCaptureEntry = ConsoleEntry | NetworkEntry | WebSocketEntry | StorageSnapshot;

/** Window-bridge message tag shared by the MAIN-world script and ISOLATED relay. */
export const IN_PAGE_CAPTURE_MESSAGE_TAG = "__gnTracingInPageCapture" as const;

/** MAIN world → relay: a captured entry to forward to the service worker. */
export interface InPageCaptureBridgeEntryMessage {
  [IN_PAGE_CAPTURE_MESSAGE_TAG]: true;
  direction: "entry";
  sessionId: string;
  kind: InPageCaptureKind;
  entry: InPageCaptureEntry;
}

/** Relay → MAIN world: lifecycle control forwarded from the service worker. */
export interface InPageCaptureBridgeControlMessage {
  [IN_PAGE_CAPTURE_MESSAGE_TAG]: true;
  direction: "control";
  type: "START" | "STOP";
  sessionId?: string;
}

export type InPageCaptureBridgeMessage =
  | InPageCaptureBridgeEntryMessage
  | InPageCaptureBridgeControlMessage;

type RecordingPhase = "idle" | "recording" | "interrupted";

type RecordingSessionPhase = "recorded" | "uploading" | "uploaded" | "failed";

export interface ServiceWorkerMessage {
  action: MessageAction;
  target?: string;
  tabId?: number;
  url?: string;
  data?: Record<string, unknown>;
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
  captureProfile: CaptureProfile;
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
  // Capture mechanism: CDP (full fidelity, debugger banner) or in-page (lower fidelity, no banner).
  captureMode: CaptureMode;
}

export type CaptureMode = "cdp" | "in-page";
export type CaptureProfile = "lean" | "balanced" | "full" | "custom";
export type PrivacyProfile = "standard" | "strict" | "custom";
type WebSocketPayloadRedactionMode = "off" | "sensitive-fields" | "all";
export interface PrivacyRedactionSettings {
  privacyProfile: PrivacyProfile;
  redactSensitiveHeaders: boolean;
  redactSensitiveQueryParams: boolean;
  redactRequestBodyFields: boolean;
  redactResponseBodyFields: boolean;
  redactConsoleValues: boolean;
  redactWebSocketPayloads: WebSocketPayloadRedactionMode;
  redactEventMetadata: boolean;
  maskDomSelectors: string[];
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
  /** @deprecated Prefer `storage`; kept for existing popup/drive-auth UI. */
  googleDrive: {
    isConnected: boolean;
  };
  settings: UploadSettings;
  uploadHistory: UploadHistoryEntry[];
}
