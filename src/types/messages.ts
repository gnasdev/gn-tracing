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
  | "ZIP_READY"
  | "OPEN_POPUP"
  | "GET_UPLOAD_STATE"
  | "GET_PLAYER_CONFIG"
  | "SET_PLAYER_CONFIG";

export type OffscreenMessageType =
  | "START_CAPTURE"
  | "STOP_CAPTURE"
  | "CREATE_ZIP"
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
  // For player config responses
  playerHostUrl?: string | null;
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

// Player configuration for external player hosting
export interface PlayerConfig {
  /**
   * URL of the standalone player deployment.
   * Example: "https://tracing.gnas.dev/player/"
   * If null/undefined, uses the built-in extension player
   */
  playerHostUrl: string | null;
}

export const PLAYER_CONFIG_KEY = "gn_tracing_player_config";
