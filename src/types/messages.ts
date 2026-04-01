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
  | "OPEN_POPUP";

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
  url?: string;
  recordingUrl?: string;
}

export interface RecordingStatus {
  isRecording: boolean;
  tabId: number | null;
  startTime: number | null;
  consoleLogCount: number;
  networkRequestCount: number;
  hasRecording: boolean;
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
