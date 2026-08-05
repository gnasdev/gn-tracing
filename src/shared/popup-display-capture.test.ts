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
  it("requests video + audio with browser surface hints", () => {
    const c = buildDisplayMediaConstraints();
    expect(c.audio).toBe(true);
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
    const media = { location: { href: "moz-extension://id/offscreen/offscreen.html" } } as Window;
    const other = { location: { href: "moz-extension://id/popup/popup.html" } } as Window;
    const view = findMediaHostView(() => [other, media]);
    expect(view).toBe(media);
  });

  it("returns null when no media host view is open", () => {
    expect(findMediaHostView(() => [])).toBeNull();
  });
});

describe("handoffDisplayStreamToMediaHost", () => {
  it("transfers tracks and resolves on adopt result", async () => {
    const track = { kind: "video", stop: vi.fn() } as unknown as MediaStreamTrack;
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

describe("popup Start prefers popup display media over focusing offscreen", () => {
  it("wires beginDisplayMediaFromGesture before START_RECORDING on Firefox", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const popupSource = readFileSync(resolve(__dirname, "../popup/popup.ts"), "utf8");
    expect(popupSource).toContain("beginDisplayMediaFromGesture");
    expect(popupSource).toContain("handoffDisplayStreamToMediaHost");
    expect(popupSource).toContain("ENSURE_MEDIA_HOST");
    expect(popupSource).toContain("mediaPrearmed: true");
    // Gesture must be captured in the click handler, not after awaits.
    const clickAt = popupSource.indexOf('toggleBtn.addEventListener("click"');
    expect(clickAt).toBeGreaterThan(-1);
    const clickBody = popupSource.slice(clickAt, clickAt + 1200);
    const beginAt = clickBody.indexOf("beginDisplayMediaFromGesture");
    const loadAt = clickBody.indexOf("loadStateFromStorage");
    expect(beginAt).toBeGreaterThan(-1);
    expect(loadAt).toBeGreaterThan(beginAt);
  });
});
