/**
 * Popup-driven Firefox display capture: share picker from the popup gesture,
 * handoff to parked media host without focusing the arm panel tab.
 */
import { describe, expect, it, vi } from "vitest";
import {
  ADOPT_DISPLAY_STREAM_MESSAGE,
  ADOPT_DISPLAY_STREAM_RESULT,
  beginDisplayMediaFromGesture,
  buildDisplayMediaConstraints,
  createRecordingSessionId,
  findMediaHostView,
  handoffDisplayStreamToMediaHost,
  isMediaHostViewUrl,
} from "./popup-display-capture";

describe("buildDisplayMediaConstraints", () => {
  it("requests video only because audio comes from selected input devices", () => {
    const c = buildDisplayMediaConstraints();
    expect(c.audio).toBe(false);
    expect(c.video).toBeTruthy();
  });
});

describe("beginDisplayMediaFromGesture", () => {
  it("invokes getDisplayMedia immediately with shared constraints", async () => {
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const getDisplayMedia = vi.fn(
      async (_constraints?: DisplayMediaStreamOptions): Promise<MediaStream> => stream,
    );
    const result = await beginDisplayMediaFromGesture(getDisplayMedia);
    expect(result).toBe(stream);
    expect(getDisplayMedia).toHaveBeenCalledOnce();
    expect(getDisplayMedia.mock.calls[0]?.[0]).toEqual(buildDisplayMediaConstraints());
  });
});

describe("isMediaHostViewUrl / findMediaHostView", () => {
  it("matches the packaged offscreen media page path", () => {
    expect(isMediaHostViewUrl("moz-extension://abc/offscreen/offscreen.html")).toBe(true);
    expect(isMediaHostViewUrl("https://example.com/")).toBe(false);
  });

  it("finds the media host among extension tab views", () => {
    const media = {
      location: { href: "moz-extension://id/offscreen/offscreen.html" },
    } as Window;
    const other = {
      location: { href: "moz-extension://id/popup/popup.html" },
    } as Window;
    const view = findMediaHostView(() => [other, media]);
    expect(view).toBe(media);
  });

  it("returns null when no media host view is open", () => {
    expect(findMediaHostView(() => [])).toBeNull();
  });
});

describe("handoffDisplayStreamToMediaHost", () => {
  it("transfers tracks and resolves on adopt result", async () => {
    const track = {
      kind: "video",
      stop: vi.fn(),
    } as unknown as MediaStreamTrack;
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    const postMessage = vi.fn();
    const mediaView = {
      location: {
        origin: "moz-extension://id",
        href: "moz-extension://id/offscreen/offscreen.html",
      },
      postMessage,
    } as unknown as Window;

    const listeners: Array<(event: MessageEvent) => void> = [];
    const messageBus = {
      addEventListener: (_type: "message", listener: (event: MessageEvent) => void) => {
        listeners.push(listener);
      },
      removeEventListener: vi.fn(),
      setTimeout: vi.fn(() => 1),
      clearTimeout: vi.fn(),
    };

    const handoff = handoffDisplayStreamToMediaHost(stream, "sess-1", {
      findView: () => mediaView,
      timeoutMs: 2000,
      messageBus,
    });

    expect(listeners).toHaveLength(1);
    const onMessage = listeners[0];
    if (!onMessage) {
      throw new Error("expected handoff to register a message listener");
    }
    onMessage({
      source: mediaView,
      data: {
        type: ADOPT_DISPLAY_STREAM_RESULT,
        sessionId: "sess-1",
        ok: true,
        firstFrameAt: 42,
        surface: { label: "Window" },
      },
    } as MessageEvent);

    const result = await handoff;
    expect(result).toEqual({
      sessionId: "sess-1",
      ok: true,
      firstFrameAt: 42,
      cancelled: undefined,
      error: undefined,
      surface: { label: "Window" },
    });
    expect(postMessage).toHaveBeenCalledWith(
      {
        type: ADOPT_DISPLAY_STREAM_MESSAGE,
        sessionId: "sess-1",
        tracks: [track],
        microphoneDeviceId: "",
        speakerDeviceId: "",
      },
      "moz-extension://id",
      [track],
    );
  });

  it("fails closed when the media host view is missing", async () => {
    const stream = {
      getTracks: () => [{ kind: "video" } as MediaStreamTrack],
    } as MediaStream;
    const result = await handoffDisplayStreamToMediaHost(stream, "sess-2", {
      findView: () => null,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not open/i);
  });
});

describe("createRecordingSessionId", () => {
  it("returns a non-empty session id", () => {
    expect(createRecordingSessionId().length).toBeGreaterThan(8);
  });
});

describe("popup Start opens the share picker immediately on Firefox", () => {
  it("starts getDisplayMedia in the Start click before any await and parks host only after share", async () => {
    // Preferred path: OS share picker from the toolbar popup gesture — no
    // intermediate "Choose what to share" panel. Park offscreen.html only after
    // the stream is live (MediaRecorder handoff), not before the picker.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const popupSource = readFileSync(resolve(__dirname, "../popup/popup.ts"), "utf8");
    expect(popupSource).toContain("beginDisplayMediaFromGesture");
    expect(popupSource).toContain("handoffDisplayStreamToMediaHost");
    expect(popupSource).toContain("mediaPrearmed: true");
    expect(popupSource).toContain("parkMediaHostWindowFromPopup");
    expect(popupSource).toContain("START_RECORDING");

    const clickAt = popupSource.indexOf('toggleBtn.addEventListener("click"');
    expect(clickAt).toBeGreaterThan(-1);
    const clickBody = popupSource.slice(clickAt, clickAt + 2400);
    const shareAt = clickBody.indexOf("beginDisplayMediaFromGesture");
    const firstRealAwait = clickBody.search(/^[ \t]*const currentState = await /m);
    expect(shareAt).toBeGreaterThan(-1);
    expect(firstRealAwait).toBeGreaterThan(-1);
    expect(shareAt).toBeLessThan(firstRealAwait);
    expect(clickBody.indexOf("parkMediaHostWindowFromPopup")).toBe(-1);

    const handoffAt = popupSource.indexOf("async function completeFirefoxPopupShare(");
    expect(handoffAt).toBeGreaterThan(-1);
    const handoffBody = popupSource.slice(handoffAt, handoffAt + 2800);
    expect(handoffBody.indexOf("parkMediaHostWindowFromPopup")).toBeGreaterThan(
      handoffBody.indexOf("streamPromise"),
    );
  });
});
