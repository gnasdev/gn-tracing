export type MessageAction =
  | "START_RECORDING"
  | "STOP_RECORDING"
  | "GET_STATUS"
  | "DOWNLOAD_RESULTS"
  | "UPLOAD_RECORDING"
  | "SET_SERVER_URL"
  | "GET_SERVER_URL"
  | "RECORDING_COMPLETE"
  | "ZIP_READY";

export type OffscreenMessageType =
  | "START_CAPTURE"
  | "STOP_CAPTURE"
  | "CREATE_ZIP"
  | "UPLOAD_TO_SERVER";

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
