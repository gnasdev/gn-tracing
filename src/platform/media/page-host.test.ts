/**
 * Firefox media host: preferred getDisplayMedia + tab-frame last resort.
 *
 * Preferred path opens a focused capture popup and auto-arms the OS share picker
 * (arm buttons stay hidden until auto-start fails). Tab-frame is last resort.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChromeMock } from "../../../test/mocks/chrome";
import { ExtensionPageMediaHost } from "./page-host";

const MEDIA_TAB_ID = 42;
const MEDIA_WINDOW_ID = 9;
const RECORDED_TAB_ID = 7;
const SESSION_ID = "session-abc";

function mock(): ChromeMock {
  return globalThis.chrome as unknown as ChromeMock;
}

/** Play the media page reporting back to the background (display arm path). */
function emitCaptureResult(data: Record<string, unknown>): void {
  mock().runtime.onMessage.emit(
    { target: "media-host", type: "DISPLAY_CAPTURE_RESULT", data },
    {} as chrome.runtime.MessageSender,
    () => {},
  );
}

function messagesOfType(type: string): unknown[] {
  return mock()
    .runtime.sendMessage.calls.map((call) => call.args[0])
    .filter((message) => (message as { type?: string })?.type === type);
}

function armMessage(): { data?: { sessionId?: string; tabTitle?: string } } | undefined {
  return messagesOfType("ARM_DISPLAY_CAPTURE")[0] as
    | { data?: { sessionId?: string; tabTitle?: string } }
    | undefined;
}

function tabFrameMessage(): { data?: { sessionId?: string; tabId?: number } } | undefined {
  return messagesOfType("START_TAB_FRAME_CAPTURE")[0] as
    | { data?: { sessionId?: string; tabId?: number } }
    | undefined;
}

function windowUpdateCalls(): Array<[number, Record<string, unknown>]> {
  return mock().windows.update.calls.map(
    (call) => [call.args[0], call.args[1]] as [number, Record<string, unknown>],
  );
}

describe("ExtensionPageMediaHost display capture", () => {
  beforeEach(() => {
    const chromeMock = mock();
    chromeMock.tabs.query.mockImplementation(() => Promise.resolve([]) as never);
    chromeMock.tabs.get.mockImplementation(
      () =>
        Promise.resolve({
          id: RECORDED_TAB_ID,
          title: "Checkout page",
          windowId: 1,
        }) as never,
    );
    chromeMock.tabs.update.mockImplementation(
      () => Promise.resolve({ id: RECORDED_TAB_ID, windowId: 1 }) as never,
    );
    chromeMock.tabs.create.mockImplementation(() => {
      throw new Error("Firefox media host must not open a browser tab");
    });
    chromeMock.windows.create.mockImplementation(
      () =>
        Promise.resolve({
          id: MEDIA_WINDOW_ID,
          tabs: [{ id: MEDIA_TAB_ID, windowId: MEDIA_WINDOW_ID }],
        }) as never,
    );
    chromeMock.windows.update.mockImplementation(
      () => Promise.resolve({ id: MEDIA_WINDOW_ID }) as never,
    );
    chromeMock.windows.remove.mockImplementation(() => Promise.resolve() as never);
    chromeMock.runtime.sendMessage.mockImplementation((message: unknown) => {
      const type = (message as { type?: string })?.type;
      if (type === "MEDIA_HOST_PING") {
        return Promise.resolve({ ok: true }) as never;
      }
      if (type === "ARM_DISPLAY_CAPTURE") {
        return Promise.resolve({ ok: true }) as never;
      }
      if (type === "START_TAB_FRAME_CAPTURE") {
        return Promise.resolve({
          ok: true,
          data: {
            firstFrameAt: 1234,
            surface: {
              displaySurface: "browser",
              label: "Recorded tab",
            },
          },
        }) as never;
      }
      return Promise.resolve({ ok: true }) as never;
    });
  });

  it("opens a focused capture popup and arms display capture first", async () => {
    const host = new ExtensionPageMediaHost();
    const started = host.startCapture(RECORDED_TAB_ID, SESSION_ID);

    await vi.waitFor(() => expect(armMessage()).toBeDefined());
    expect(tabFrameMessage()).toBeUndefined();
    expect(armMessage()?.data?.sessionId).toBe(SESSION_ID);

    const createArgs = mock().windows.create.calls.map(
      (call) => call.args[0] as Record<string, unknown>,
    );
    expect(createArgs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "popup",
          focused: true,
          url: expect.stringContaining("offscreen/offscreen.html"),
        }),
      ]),
    );

    emitCaptureResult({
      sessionId: SESSION_ID,
      ok: true,
      firstFrameAt: 50,
      surface: { label: "Firefox" },
    });
    await expect(started).resolves.toBe(50);
    expect(host.activeSessionId).toBe(SESSION_ID);
  });

  it("prearmed path binds session without opening the capture window", async () => {
    const host = new ExtensionPageMediaHost();
    const firstFrameAt = await host.startCapture(RECORDED_TAB_ID, SESSION_ID, {
      prearmed: true,
      firstFrameAt: 99,
      capturedSurface: { label: "My Window" },
    });
    expect(firstFrameAt).toBe(99);
    expect(host.activeSessionId).toBe(SESSION_ID);
    expect(host.capturedSurface).toEqual({ label: "My Window" });
    expect(tabFrameMessage()).toBeUndefined();
    expect(armMessage()).toBeUndefined();
    expect(mock().windows.create.calls).toHaveLength(0);
  });

  it("falls back to tab-frame capture when display arm fails", async () => {
    mock().runtime.sendMessage.mockImplementation((message: unknown) => {
      const type = (message as { type?: string })?.type;
      if (type === "MEDIA_HOST_PING") {
        return Promise.resolve({ ok: true }) as never;
      }
      if (type === "ARM_DISPLAY_CAPTURE") {
        return Promise.resolve({
          ok: false,
          error: "no arm panel",
        }) as never;
      }
      if (type === "START_TAB_FRAME_CAPTURE") {
        return Promise.resolve({
          ok: true,
          data: {
            firstFrameAt: 1234,
            surface: {
              displaySurface: "browser",
              label: "Recorded tab",
            },
          },
        }) as never;
      }
      return Promise.resolve({ ok: true }) as never;
    });

    const host = new ExtensionPageMediaHost();
    const firstFrameAt = await host.startCapture(RECORDED_TAB_ID, SESSION_ID);

    expect(armMessage()).toBeDefined();
    expect(tabFrameMessage()?.data).toEqual({
      tabId: RECORDED_TAB_ID,
      sessionId: SESSION_ID,
      microphoneEnabled: true,
      microphoneDeviceId: "",
    });
    expect(firstFrameAt).toBe(1234);
    expect(host.capturedSurface).toEqual({
      displaySurface: "browser",
      label: "Recorded tab",
    });
  });

  it("rejects when the user cancels sharing without starting tab-frame", async () => {
    const host = new ExtensionPageMediaHost();
    const started = host.startCapture(RECORDED_TAB_ID, SESSION_ID);
    await vi.waitFor(() => expect(armMessage()).toBeDefined());

    emitCaptureResult({
      sessionId: SESSION_ID,
      ok: false,
      cancelled: true,
      error: "Screen sharing was cancelled, so recording did not start.",
    });

    await expect(started).rejects.toThrow(/cancelled/);
    expect(tabFrameMessage()).toBeUndefined();
    expect(host.activeSessionId).toBeNull();
  });

  it("restoreRecordedTabFocus returns to the recorded tab after display capture", async () => {
    const host = new ExtensionPageMediaHost();
    const started = host.startCapture(RECORDED_TAB_ID, SESSION_ID);
    await vi.waitFor(() => expect(armMessage()).toBeDefined());
    emitCaptureResult({
      sessionId: SESSION_ID,
      ok: true,
      firstFrameAt: 50,
    });
    await expect(started).resolves.toBe(50);

    await host.restoreRecordedTabFocus(RECORDED_TAB_ID);
    expect(
      mock().tabs.update.calls.some(
        (call) =>
          call.args[0] === RECORDED_TAB_ID && (call.args[1] as { active?: boolean })?.active,
      ),
    ).toBe(true);
    expect(windowUpdateCalls()).toEqual(
      expect.arrayContaining([[MEDIA_WINDOW_ID, expect.objectContaining({ state: "minimized" })]]),
    );
  });

  it("restoreRecordedTabFocus only minimizes after tab-frame fallback", async () => {
    mock().runtime.sendMessage.mockImplementation((message: unknown) => {
      const type = (message as { type?: string })?.type;
      if (type === "MEDIA_HOST_PING") {
        return Promise.resolve({ ok: true }) as never;
      }
      if (type === "ARM_DISPLAY_CAPTURE") {
        return Promise.resolve({ ok: false, error: "no arm" }) as never;
      }
      if (type === "START_TAB_FRAME_CAPTURE") {
        return Promise.resolve({
          ok: true,
          data: {
            firstFrameAt: 9,
            surface: { displaySurface: "browser" },
          },
        }) as never;
      }
      return Promise.resolve({ ok: true }) as never;
    });

    const host = new ExtensionPageMediaHost();
    await host.startCapture(RECORDED_TAB_ID, SESSION_ID);
    const tabsUpdateBefore = mock().tabs.update.callCount;

    await host.restoreRecordedTabFocus(RECORDED_TAB_ID);

    expect(
      mock()
        .tabs.update.calls.slice(tabsUpdateBefore)
        .filter(
          (call) =>
            call.args[0] === RECORDED_TAB_ID && (call.args[1] as { active?: boolean })?.active,
        ),
    ).toHaveLength(0);
  });
});
