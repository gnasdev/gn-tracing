/**
 * Unit tests for the service-worker message router.
 * Drives the real `registerMessageListeners` with stub handlers and the
 * chrome.runtime.onMessage mock — no reimplementation of the switch table.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChromeMock } from "../../test/mocks/chrome";
import { type MessageHandlers, registerMessageListeners } from "./message-router";

function chromeMock(): ChromeMock {
  return chrome as unknown as ChromeMock;
}

function makeHandlers(overrides: Partial<MessageHandlers> = {}): MessageHandlers {
  const base: MessageHandlers = {
    startRecording: vi.fn(async () => ({ ok: true })),
    stopRecording: vi.fn(async () => ({ ok: true })),
    removeRecording: vi.fn(async () => ({ ok: true })),
    getRecordingStatus: vi.fn(() => null),
    getPopupSettingsResponse: vi.fn(async () => ({
      ok: true,
      settings: {} as never,
      uploadHistory: [],
    })),
    updateUploadSettingsFromMessage: vi.fn(async () => ({ ok: true })),
    deleteUploadHistoryEntry: vi.fn(async () => ({ ok: true })),
    deleteSession: vi.fn(async () => ({ ok: true })),
    handleRecordingUserEvent: vi.fn(() => ({ ok: true })),
    handleRecordingDrawStroke: vi.fn(() => ({ ok: true })),
    handleRecordingDrawClear: vi.fn(() => ({ ok: true })),
    toggleDrawingOverlay: vi.fn(async () => ({ ok: true })),
    getDrawingOverlayState: vi.fn(async () => ({ ok: true, active: false })),
    setDrawingColor: vi.fn(async () => ({ ok: true })),
    uploadSessionToGoogleDrive: vi.fn(async () => ({ ok: true })),
    getUploadState: vi.fn(() => []),
    storageConnect: vi.fn(async () => ({ ok: true })),
    storageDisconnect: vi.fn(async () => ({ ok: true })),
    storageStatus: vi.fn(async () => ({ ok: true })),
    getStorageToken: vi.fn(async () => ({ ok: true, token: null })),
    onRecordingComplete: vi.fn(),
    getUploadArtifactChunk: vi.fn(() => ({ ok: false, error: "none" }) as never),
    patchUploadProgress: vi.fn(),
    submitFeedback: vi.fn(async () => ({ ok: true })),
    captureScreenshot: vi.fn(async () => ({ ok: true })),
    getPendingScreenshot: vi.fn(async () => ({ ok: true })),
    discardPendingScreenshot: vi.fn(async () => ({ ok: true })),
    saveAnnotatedScreenshot: vi.fn(async () => ({ ok: true })),
    captureInstantReplay: vi.fn(async () => ({ ok: true })),
    handleInPageCaptureEntry: vi.fn(() => ({ ok: true })),
    ensureMediaHost: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
  return {
    ...base,
    // Required handler — never leave undefined via Partial overrides.
    handleInPageCaptureEntry: overrides.handleInPageCaptureEntry ?? base.handleInPageCaptureEntry,
  };
}

async function dispatch(
  message: Record<string, unknown>,
  sender: chrome.runtime.MessageSender = {},
): Promise<unknown> {
  return new Promise((resolve) => {
    const handled = chromeMock().runtime.onMessage.emit(
      message as never,
      sender,
      (response: unknown) => resolve(response),
    );
    // Our mock emit always calls listeners; collect via sendResponse.
    void handled;
  });
}

describe("registerMessageListeners", () => {
  let handlers: MessageHandlers;

  beforeEach(() => {
    handlers = makeHandlers();
    registerMessageListeners(handlers);
  });

  it("routes START_RECORDING with tabId to startRecording", async () => {
    const response = await dispatch({ action: "START_RECORDING", tabId: 7 });
    expect(handlers.startRecording).toHaveBeenCalledWith(7, undefined);
    expect(response).toEqual({ ok: true });
  });

  it("routes CAPTURE_INSTANT_REPLAY with tabId", async () => {
    handlers.captureInstantReplay = vi.fn(async () => ({ ok: true }));
    await dispatch({
      action: "CAPTURE_INSTANT_REPLAY",
      tabId: 9,
    });
    expect(handlers.captureInstantReplay).toHaveBeenCalledWith(9);
  });

  it("rejects START_RECORDING without tabId", async () => {
    const response = await dispatch({ action: "START_RECORDING" });
    expect(handlers.startRecording).not.toHaveBeenCalled();
    expect(response).toMatchObject({ ok: false });
  });

  it("answers ok:false when a handler rejects instead of leaving the popup hanging", async () => {
    handlers.updateUploadSettingsFromMessage = vi.fn(async () => {
      throw new Error("boom");
    });
    const response = await dispatch({
      action: "UPDATE_SETTINGS",
      data: { microphoneEnabled: false },
    });
    expect(response).toMatchObject({ ok: false, error: "boom" });
  });

  it("routes STOP_RECORDING", async () => {
    await dispatch({ action: "STOP_RECORDING" });
    expect(handlers.stopRecording).toHaveBeenCalledOnce();
  });

  it("maps GOOGLE_DRIVE_CONNECT alias to storageConnect with google-drive provider", async () => {
    await dispatch({ action: "GOOGLE_DRIVE_CONNECT", data: { foo: 1 } });
    expect(handlers.storageConnect).toHaveBeenCalledWith({
      foo: 1,
      provider: "google-drive",
    });
  });

  it("maps STORAGE_CONNECT without forcing provider", async () => {
    await dispatch({ action: "STORAGE_CONNECT", data: { provider: "dropbox" } });
    expect(handlers.storageConnect).toHaveBeenCalledWith({ provider: "dropbox" });
  });

  it("maps GET_GOOGLE_DRIVE_TOKEN alias to getStorageToken with google-drive", async () => {
    await dispatch({ action: "GET_GOOGLE_DRIVE_TOKEN", data: {} });
    expect(handlers.getStorageToken).toHaveBeenCalledWith({ provider: "google-drive" });
  });

  it("maps GOOGLE_DRIVE_DISCONNECT and GOOGLE_DRIVE_STATUS aliases", async () => {
    await dispatch({ action: "GOOGLE_DRIVE_DISCONNECT" });
    expect(handlers.storageDisconnect).toHaveBeenCalledWith({ provider: "google-drive" });
    await dispatch({ action: "GOOGLE_DRIVE_STATUS", data: { x: true } });
    expect(handlers.storageStatus).toHaveBeenCalledWith({ x: true, provider: "google-drive" });
  });

  it("returns unknown action error for unrecognized actions", async () => {
    const response = await dispatch({ action: "NOT_A_REAL_ACTION" });
    expect(response).toEqual({ ok: false, error: "Unknown action" });
  });

  it("ignores messages targeted at non-service-worker surfaces", async () => {
    // Listener returns false and does not call sendResponse — Promise stays pending
    // unless we only check that handlers were not invoked.
    chromeMock().runtime.onMessage.emit(
      { action: "STOP_RECORDING", target: "offscreen" } as never,
      {},
      () => {},
    );
    expect(handlers.stopRecording).not.toHaveBeenCalled();
  });

  it("routes offscreen UPLOAD_PROGRESS to patchUploadProgress", async () => {
    const sendResponse = vi.fn();
    chromeMock().runtime.onMessage.emit(
      {
        target: "offscreen",
        type: "UPLOAD_PROGRESS",
        data: { sessionId: "sess-1", percent: 40 },
      } as never,
      {},
      sendResponse,
    );
    expect(handlers.patchUploadProgress).toHaveBeenCalledWith("sess-1", {
      sessionId: "sess-1",
      percent: 40,
    });
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });

  it("routes IN_PAGE_CAPTURE_ENTRY to handleInPageCaptureEntry", async () => {
    const entry = { timestamp: 1, message: "log" };
    const response = await dispatch({
      action: "IN_PAGE_CAPTURE_ENTRY",
      sessionId: "sess-ip",
      kind: "console",
      entry,
    });
    expect(handlers.handleInPageCaptureEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "IN_PAGE_CAPTURE_ENTRY",
        sessionId: "sess-ip",
        kind: "console",
        entry,
      }),
    );
    expect(response).toEqual({ ok: true });
  });

  it("routes SUBMIT_FEEDBACK and CAPTURE_SCREENSHOT", async () => {
    await dispatch({ action: "SUBMIT_FEEDBACK", data: { message: "hi" } });
    expect(handlers.submitFeedback).toHaveBeenCalledWith({ message: "hi" });
    await dispatch({ action: "CAPTURE_SCREENSHOT", tabId: 3 });
    expect(handlers.captureScreenshot).toHaveBeenCalledWith(3);
  });
});
