/**
 * Firefox media host arming.
 *
 * getDisplayMedia needs transient user activation, so the background cannot
 * start capture by message alone — it opens a capture popup window, waits for
 * the user's click there, and only then reports a live stream. These tests pin
 * that handshake plus the failure paths (cancel, unreachable page, timeout).
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

/** Play the media page reporting back to the background. */
function emitCaptureResult(data: Record<string, unknown>): void {
  mock().runtime.onMessage.emit(
    { target: "media-host", type: "DISPLAY_CAPTURE_RESULT", data },
    {} as chrome.runtime.MessageSender,
    () => {},
  );
}

function armMessage(): { data?: { sessionId?: string; tabTitle?: string } } | undefined {
  return mock().runtime.sendMessage.calls.find(
    (call) => (call.args[0] as { type?: string })?.type === "ARM_DISPLAY_CAPTURE",
  )?.args[0] as { data?: { sessionId?: string; tabTitle?: string } } | undefined;
}

function windowUpdateCalls(): Array<[number, Record<string, unknown>]> {
  return mock().windows.update.calls.map(
    (call) => [call.args[0], call.args[1]] as [number, Record<string, unknown>],
  );
}

describe("ExtensionPageMediaHost display-capture arming", () => {
  beforeEach(() => {
    const chromeMock = mock();
    chromeMock.tabs.query.mockImplementation(() => Promise.resolve([]) as never);
    chromeMock.tabs.get.mockImplementation(
      () => Promise.resolve({ id: RECORDED_TAB_ID, title: "Checkout page", windowId: 1 }) as never,
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
    chromeMock.runtime.sendMessage.mockImplementation(() => Promise.resolve({ ok: true }) as never);
  });

  it("opens a capture popup window (not a tab), arms it, and resolves on success", async () => {
    const host = new ExtensionPageMediaHost();
    const started = host.startCapture(RECORDED_TAB_ID, SESSION_ID);

    await vi.waitFor(() => expect(armMessage()).toBeDefined());

    expect(armMessage()?.data?.sessionId).toBe(SESSION_ID);
    expect(armMessage()?.data?.tabTitle).toBe("Checkout page");
    // Must use a popup window, never tabs.create in the user's strip.
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
    expect(mock().tabs.create.calls).toHaveLength(0);
    // Capture window is focused for the share click.
    expect(windowUpdateCalls()).toEqual(
      expect.arrayContaining([
        [MEDIA_WINDOW_ID, expect.objectContaining({ focused: true, state: "normal" })],
      ]),
    );

    emitCaptureResult({ sessionId: SESSION_ID, ok: true, firstFrameAt: 1234 });

    await expect(started).resolves.toBe(1234);
    expect(host.activeSessionId).toBe(SESSION_ID);
    // Evidence arms before focus restore; caller invokes restoreRecordedTabFocus.
    expect(
      mock().tabs.update.calls.filter(
        (call) =>
          call.args[0] === RECORDED_TAB_ID && (call.args[1] as { active?: boolean })?.active,
      ),
    ).toHaveLength(0);
  });

  it("prearmed path binds session without opening or focusing the capture window", async () => {
    const host = new ExtensionPageMediaHost();
    const firstFrameAt = await host.startCapture(RECORDED_TAB_ID, SESSION_ID, {
      prearmed: true,
      firstFrameAt: 99,
      capturedSurface: { label: "My Window" },
    });
    expect(firstFrameAt).toBe(99);
    expect(host.activeSessionId).toBe(SESSION_ID);
    expect(host.capturedSurface).toEqual({ label: "My Window" });
    expect(armMessage()).toBeUndefined();
    expect(mock().windows.create.calls).toHaveLength(0);
    expect(
      mock().runtime.sendMessage.calls.filter(
        (call) => (call.args[0] as { type?: string })?.type === "ARM_DISPLAY_CAPTURE",
      ),
    ).toHaveLength(0);
  });

  it("rejects with the page's reason when the user cancels sharing", async () => {
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
    expect(host.activeSessionId).toBeNull();
  });

  it("ignores a result belonging to a different session", async () => {
    const host = new ExtensionPageMediaHost();
    const started = host.startCapture(RECORDED_TAB_ID, SESSION_ID);
    await vi.waitFor(() => expect(armMessage()).toBeDefined());

    emitCaptureResult({ sessionId: "some-other-session", ok: true, firstFrameAt: 999 });

    let settled = false;
    void started.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    emitCaptureResult({ sessionId: SESSION_ID, ok: true, firstFrameAt: 5 });
    await expect(started).resolves.toBe(5);
  });

  it("fails with an actionable error when the media page does not answer the arm", async () => {
    mock().runtime.sendMessage.mockImplementation((message: unknown) => {
      const type = (message as { type?: string })?.type;
      if (type === "MEDIA_HOST_PING") {
        return Promise.resolve({ ok: true }) as never;
      }
      return Promise.resolve(undefined) as never;
    });

    const host = new ExtensionPageMediaHost();
    await expect(host.startCapture(RECORDED_TAB_ID, SESSION_ID)).rejects.toThrow(/capture window/i);
    expect(host.activeSessionId).toBeNull();
  });

  it("stops waiting instead of hanging when the user never clicks share", async () => {
    vi.useFakeTimers();
    try {
      const host = new ExtensionPageMediaHost();
      const started = host.startCapture(RECORDED_TAB_ID, SESSION_ID);
      const assertion = expect(started).rejects.toThrow(/Timed out/);

      await vi.advanceTimersByTimeAsync(300);
      expect(armMessage()).toBeDefined();

      await vi.advanceTimersByTimeAsync(180_000);
      await assertion;
      expect(host.activeSessionId).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("timeout names Choose what to share, never Share this tab", async () => {
    vi.useFakeTimers();
    try {
      const host = new ExtensionPageMediaHost();
      const started = host.startCapture(RECORDED_TAB_ID, SESSION_ID);
      let errorMessage = "";
      const pending = started.catch((error: Error) => {
        errorMessage = error.message;
      });
      await vi.advanceTimersByTimeAsync(300);
      await vi.advanceTimersByTimeAsync(180_000);
      await pending;
      expect(errorMessage).toMatch(/Timed out/i);
      expect(errorMessage).toContain("Choose what to share");
      expect(errorMessage).not.toMatch(/Share this tab/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("minimizes the capture window and restores recorded-tab focus after share", async () => {
    const host = new ExtensionPageMediaHost();
    const started = host.startCapture(RECORDED_TAB_ID, SESSION_ID);
    await vi.waitFor(() => expect(armMessage()).toBeDefined());
    emitCaptureResult({ sessionId: SESSION_ID, ok: true, firstFrameAt: 50 });
    await expect(started).resolves.toBe(50);

    // After share commit, recorded tab should not yet have been focused back.
    expect(
      mock().tabs.update.calls.filter(
        (call) =>
          call.args[0] === RECORDED_TAB_ID && (call.args[1] as { active?: boolean })?.active,
      ),
    ).toHaveLength(0);

    await host.restoreRecordedTabFocus(RECORDED_TAB_ID);
    expect(windowUpdateCalls()).toEqual(
      expect.arrayContaining([[MEDIA_WINDOW_ID, expect.objectContaining({ state: "minimized" })]]),
    );
    expect(
      mock().tabs.update.calls.some(
        (call) =>
          call.args[0] === RECORDED_TAB_ID && (call.args[1] as { active?: boolean })?.active,
      ),
    ).toBe(true);
  });
});
