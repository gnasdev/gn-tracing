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
  /** Generic storage connect (optional provider in data; defaults to active/google-drive). */
  storageConnect: (data?: Record<string, unknown>) => Promise<MessageResponse>;
  storageDisconnect: (data?: Record<string, unknown>) => Promise<MessageResponse>;
  storageStatus: (data?: Record<string, unknown>) => Promise<MessageResponse>;
  getStorageToken: (
    data?: Record<string, unknown>,
  ) => Promise<{ ok: boolean; token: string | null }>;
  onRecordingComplete: (sessionId: string | undefined) => void;
  getUploadArtifactChunk: (
    data: Record<string, unknown> | undefined,
  ) => UploadArtifactChunkResponse;
  patchUploadProgress: (sessionId: string, data: Record<string, unknown>) => void;
  submitFeedback: (data: Record<string, unknown> | undefined) => Promise<MessageResponse>;
  captureScreenshot: (tabId: number | undefined) => Promise<MessageResponse>;
  getPendingScreenshot: () => Promise<MessageResponse & { screenshot?: unknown }>;
  discardPendingScreenshot: () => Promise<MessageResponse>;
  saveAnnotatedScreenshot: (data: Record<string, unknown> | undefined) => Promise<MessageResponse>;
}

export function registerMessageListeners(handlers: MessageHandlers): void {
  chrome.runtime.onMessage.addListener((message: ServiceWorkerMessage, sender, sendResponse) => {
    if (message.target && message.target !== "service-worker") {
      return false;
    }

    handleMessage(message, sender, handlers).then(sendResponse);
    return true;
  });

  chrome.runtime.onMessage.addListener(
    (
      message: { target?: string; type?: string; data?: Record<string, unknown> },
      _sender,
      sendResponse,
    ) => {
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
    },
  );
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
    case "STORAGE_CONNECT":
    case "GOOGLE_DRIVE_CONNECT":
      // GOOGLE_DRIVE_* aliases map to google-drive (or explicit provider in data).
      return handlers.storageConnect(
        message.action === "GOOGLE_DRIVE_CONNECT"
          ? { ...message.data, provider: "google-drive" }
          : message.data,
      );
    case "STORAGE_DISCONNECT":
    case "GOOGLE_DRIVE_DISCONNECT":
      return handlers.storageDisconnect(
        message.action === "GOOGLE_DRIVE_DISCONNECT"
          ? { ...message.data, provider: "google-drive" }
          : message.data,
      );
    case "STORAGE_STATUS":
    case "GOOGLE_DRIVE_STATUS":
      return handlers.storageStatus(
        message.action === "GOOGLE_DRIVE_STATUS"
          ? { ...message.data, provider: "google-drive" }
          : message.data,
      );
    case "GET_STORAGE_TOKEN":
    case "GET_GOOGLE_DRIVE_TOKEN":
      return handlers.getStorageToken(
        message.action === "GET_GOOGLE_DRIVE_TOKEN"
          ? { ...message.data, provider: "google-drive" }
          : message.data,
      );
    case "RECORDING_COMPLETE":
      handlers.onRecordingComplete(
        typeof message.data?.sessionId === "string" ? message.data.sessionId : undefined,
      );
      return { ok: true };
    case "GET_UPLOAD_ARTIFACT_CHUNK":
      return handlers.getUploadArtifactChunk(message.data);
    case "CAPTURE_SCREENSHOT":
      return handlers.captureScreenshot(message.tabId);
    case "GET_PENDING_SCREENSHOT":
      return handlers.getPendingScreenshot();
    case "DISCARD_PENDING_SCREENSHOT":
      return handlers.discardPendingScreenshot();
    case "SAVE_ANNOTATED_SCREENSHOT":
      return handlers.saveAnnotatedScreenshot(message.data);
    case "SUBMIT_FEEDBACK":
      return handlers.submitFeedback(message.data);
    default:
      return { ok: false, error: "Unknown action" };
  }
}
