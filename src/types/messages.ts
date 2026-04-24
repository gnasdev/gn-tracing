export type MessageAction =
  | "START_RECORDING"
  | "STOP_RECORDING"
  | "PAUSE_RECORDING"
  | "RESUME_RECORDING"
  | "GET_STATUS"
  | "GET_SETTINGS"
  | "UPDATE_SETTINGS"
  | "DELETE_UPLOAD_HISTORY_ENTRY"
  | "DELETE_SESSION"
  | "GOOGLE_DRIVE_CONNECT"
  | "GOOGLE_DRIVE_DISCONNECT"
  | "GOOGLE_DRIVE_STATUS"
  | "GET_GOOGLE_DRIVE_TOKEN"
  | "UPLOAD_TO_GOOGLE_DRIVE"
  | "RECORDING_COMPLETE"
  | "GET_UPLOAD_STATE";

export type OffscreenMessageType =
  | "START_CAPTURE"
  | "STOP_CAPTURE"
  | "PAUSE_CAPTURE"
  | "RESUME_CAPTURE"
  | "GET_CAPTURE_STATE"
  | "UPLOAD_TO_GOOGLE_DRIVE"
  | "DELETE_SESSION_SNAPSHOT"
  | "UPLOAD_PROGRESS";

export type RecordingPhase =
  | "idle"
  | "recording"
  | "paused"
  | "interrupted";

export type RecordingSessionPhase =
  | "recorded"
  | "uploading"
  | "uploaded"
  | "failed";

export interface ServiceWorkerMessage {
  action: MessageAction;
  target?: string;
  tabId?: number;
  url?: string;
  data?: Record<string, unknown>;
}

export interface OffscreenMessage {
  target: "offscreen";
  type: OffscreenMessageType;
  data?: Record<string, unknown>;
}

export interface MessageResponse {
  ok: boolean;
  error?: string;
  message?: string;
  url?: string;
  recordingUrl?: string;
  token?: string | null;
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
  isPaused: boolean;
  tabId: number | null;
  startTime: number | null;
  stopTime?: number | null;
  tabUrl?: string | null;
  elapsedMs: number;
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

export interface UploadState {
  isUploading: boolean;
  progress: number;
  uploadedBytes: number;
  totalBytes: number;
  message: string;
  items: ProgressItemSnapshot[];
  recordingUrl: string | null;
  error: string | null;
}

export interface UploadSettings {
  folderInput: string;
  folderId: string | null;
}

export interface UploadHistoryEntry {
  id: string;
  uploadedAt: number;
  pageUrl: string;
  recordingUrl: string;
  recordingFolderId: string;
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

export interface UploadProgressMessage {
  target: "offscreen";
  type: "UPLOAD_PROGRESS";
  data: {
    sessionId: string;
    step: number;
    total: number;
    percent: number;
    uploadedBytes: number;
    totalBytes: number;
    message: string;
    items: ProgressItemSnapshot[];
  };
}
