import type {
  MessageResponse,
  PopupState,
  RecordingSessionSummary,
  RecordingStatus,
  ServiceWorkerMessage,
  UploadHistoryEntry,
  UploadSettings,
} from "../types/messages";
import type { UploadArtifactChunkResponse } from "./upload-orchestrator";

export interface MessageHandlers {
  startRecording: (tabId: number) => Promise<MessageResponse>;
  stopRecording: () => Promise<MessageResponse>;
  removeRecording: () => Promise<MessageResponse>;
  getRecordingStatus: () => RecordingStatus | null;
  getPopupSettingsResponse: () => Promise<
    MessageResponse & {
      settings: UploadSettings;
      uploadHistory: UploadHistoryEntry[];
    }
  >;
  updateUploadSettingsFromMessage: (
    data: Record<string, unknown> | undefined,
  ) => Promise<MessageResponse & { settings?: UploadSettings }>;
  deleteUploadHistoryEntry: (data: Record<string, unknown> | undefined) => Promise<MessageResponse>;
  deleteSession: (data: Record<string, unknown> | undefined) => Promise<MessageResponse>;
  handleRecordingUserEvent: (
    data: Record<string, unknown> | undefined,
    sender: chrome.runtime.MessageSender,
  ) => MessageResponse;
  handleRecordingDrawStroke: (
    data: Record<string, unknown> | undefined,
    sender: chrome.runtime.MessageSender,
  ) => MessageResponse;
  handleRecordingDrawClear: (
    data: Record<string, unknown> | undefined,
    sender: chrome.runtime.MessageSender,
  ) => MessageResponse;
  toggleDrawingOverlay: (data?: Record<string, unknown>) => Promise<MessageResponse>;
  getDrawingOverlayState: () => Promise<MessageResponse & { active?: boolean; color?: string }>;
  setDrawingColor: (
    data?: Record<string, unknown>,
  ) => Promise<MessageResponse & { color?: string }>;
  handleRecordingInPageEntry: (
    data: Record<string, unknown> | undefined,
    sender: chrome.runtime.MessageSender,
  ) => MessageResponse;
  uploadSessionToGoogleDrive: (
    data: Record<string, unknown> | undefined,
  ) => Promise<MessageResponse>;
  getUploadState: () => RecordingSessionSummary[];
  googleDriveConnect: () => Promise<MessageResponse>;
  googleDriveDisconnect: () => Promise<MessageResponse>;
  googleDriveStatus: () => Promise<MessageResponse>;
  getGoogleDriveToken: () => Promise<{ ok: boolean; token: string | null }>;
  onRecordingComplete: (sessionId: string | undefined) => void;
  getUploadArtifactChunk: (
    data: Record<string, unknown> | undefined,
  ) => UploadArtifactChunkResponse;
  patchUploadProgress: (sessionId: string, data: Record<string, unknown>) => void;
}

export function registerMessageListeners(handlers: MessageHandlers): void {
  chrome.runtime.onMessage.addListener((message: ServiceWorkerMessage, sender, sendResponse) => {
    if (message.target && message.target !== "service-worker") {
      return false;
    }

    handleMessage(message, sender, handlers).then(sendResponse);
    return true;
  });

  chrome.runtime.onMessage.addListener((message: any, _sender, sendResponse) => {
    if (
      message.target !== "offscreen" ||
      message.type !== "UPLOAD_PROGRESS" ||
      !message.data?.sessionId
    ) {
      return false;
    }

    const sessionId = String(message.data.sessionId);
    handlers.patchUploadProgress(sessionId, message.data || {});
    sendResponse({ ok: true });
    return true;
  });
}

async function handleMessage(
  message: ServiceWorkerMessage,
  sender: chrome.runtime.MessageSender,
  handlers: MessageHandlers,
): Promise<
  MessageResponse | UploadArtifactChunkResponse | RecordingStatus | PopupState["sessions"] | null
> {
  switch (message.action) {
    case "START_RECORDING":
      return typeof message.tabId === "number"
        ? handlers.startRecording(message.tabId)
        : { ok: false, error: "Open a browser tab before starting a recording." };
    case "STOP_RECORDING":
      return handlers.stopRecording();
    case "REMOVE_RECORDING":
      return handlers.removeRecording();
    case "GET_STATUS":
      return handlers.getRecordingStatus();
    case "GET_SETTINGS":
      return handlers.getPopupSettingsResponse();
    case "UPDATE_SETTINGS":
      return handlers.updateUploadSettingsFromMessage(message.data);
    case "DELETE_UPLOAD_HISTORY_ENTRY":
      return handlers.deleteUploadHistoryEntry(message.data);
    case "DELETE_SESSION":
      return handlers.deleteSession(message.data);
    case "RECORDING_USER_EVENT":
      return handlers.handleRecordingUserEvent(message.data, sender);
    case "RECORDING_DRAW_STROKE":
      return handlers.handleRecordingDrawStroke(message.data, sender);
    case "RECORDING_DRAW_CLEAR":
      return handlers.handleRecordingDrawClear(message.data, sender);
    case "TOGGLE_DRAWING_OVERLAY":
      return handlers.toggleDrawingOverlay(message.data);
    case "GET_DRAWING_OVERLAY_STATE":
      return handlers.getDrawingOverlayState();
    case "SET_DRAWING_COLOR":
      return handlers.setDrawingColor(message.data);
    case "RECORDING_INPAGE_ENTRY":
      return handlers.handleRecordingInPageEntry(message.data, sender);
    case "UPLOAD_TO_GOOGLE_DRIVE":
      return handlers.uploadSessionToGoogleDrive(message.data);
    case "GET_UPLOAD_STATE":
      return handlers.getUploadState();
    case "GOOGLE_DRIVE_CONNECT":
      return handlers.googleDriveConnect();
    case "GOOGLE_DRIVE_DISCONNECT":
      return handlers.googleDriveDisconnect();
    case "GOOGLE_DRIVE_STATUS":
      return handlers.googleDriveStatus();
    case "GET_GOOGLE_DRIVE_TOKEN":
      return handlers.getGoogleDriveToken();
    case "RECORDING_COMPLETE":
      handlers.onRecordingComplete(
        typeof message.data?.sessionId === "string" ? message.data.sessionId : undefined,
      );
      return { ok: true };
    case "GET_UPLOAD_ARTIFACT_CHUNK":
      return handlers.getUploadArtifactChunk(message.data);
    default:
      return { ok: false, error: "Unknown action" };
  }
}
