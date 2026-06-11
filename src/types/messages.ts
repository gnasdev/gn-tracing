/**
 * Message contracts shared between extension UIs, service worker, and offscreen runtime.
 */
type MessageAction =
  | "START_RECORDING"
  | "STOP_RECORDING"
  | "REMOVE_RECORDING"
  | "GET_STATUS"
  | "GET_SETTINGS"
  | "UPDATE_SETTINGS"
  | "CHECK_FOR_UPDATE"
  | "DELETE_UPLOAD_HISTORY_ENTRY"
  | "DELETE_SESSION"
  | "RECORDING_USER_EVENT"
  | "GOOGLE_DRIVE_CONNECT"
  | "GOOGLE_DRIVE_DISCONNECT"
  | "GOOGLE_DRIVE_STATUS"
  | "GET_GOOGLE_DRIVE_TOKEN"
  | "UPLOAD_TO_GOOGLE_DRIVE"
  | "RECORDING_COMPLETE"
  | "GET_UPLOAD_ARTIFACT_CHUNK"
  | "GET_UPLOAD_STATE";

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
  update?: UpdateCheckResult;
}

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  isUpdateAvailable: boolean;
  downloadUrl?: string;
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
}

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
}

export interface PopupState {
  recording: RecordingStatus | null;
  sessions: RecordingSessionSummary[];
  googleDrive: {
    isConnected: boolean;
  };
  settings: UploadSettings;
  uploadHistory: UploadHistoryEntry[];
}
