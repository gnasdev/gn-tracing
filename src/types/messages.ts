export type MessageAction =
  | "START_RECORDING"
  | "STOP_RECORDING"
  | "GET_STATUS"
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
  | "UPLOAD_TO_GOOGLE_DRIVE"
  | "UPLOAD_PROGRESS";

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
  // For auth token responses
  token?: string | null;
}

export interface RecordingStatus {
  isRecording: boolean;
  tabId: number | null;
  startTime: number | null;
  consoleLogCount: number;
  networkRequestCount: number;
  hasRecording: boolean;
}

export interface UploadState {
  isUploading: boolean;
  progress: number;
  message: string;
  recordingUrl: string | null;
  error: string | null;
}

export interface PopupState {
  // Recording state
  recordingStatus: RecordingStatus | null;
  // Upload state
  uploadState: UploadState;
  // Google Drive state
  googleDriveConnected: boolean;
}

export interface UploadProgressMessage {
  target: "offscreen";
  type: "UPLOAD_PROGRESS";
  data: {
    step: number;
    total: number;
    message: string;
  };
}
