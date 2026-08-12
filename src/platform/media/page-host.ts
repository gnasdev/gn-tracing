/**
 * Firefox media host: getDisplayMedia + MediaRecorder (tab-frame as last resort).
 *
 * Preferred full-record video uses the OS share picker. The popup Start path
 * usually hands off a prearmed stream; otherwise this host opens a small popup
 * window and auto-starts getDisplayMedia (no intermediate "Choose what to share"
 * button until the engine blocks auto-start). Tab-frame snapshots are last resort.
 */

import type { CapturedSurface } from "../../media-pipeline/capture-surface";
import { describeFirefoxArmTimeoutMessage } from "../../shared/firefox-arm-copy";
import { MEDIA_PAGE_MESSAGE_TARGET } from "./message-target";
import type { MediaHost, MediaStartCaptureOptions } from "./types";

/** Same HTML/JS as Chromium offscreen document — opened as a popup window on Firefox. */
const MEDIA_PAGE_PATH = "offscreen/offscreen.html";

/** Compact capture UI; large enough for legacy arm panel fallback. */
const CAPTURE_WINDOW_WIDTH = 480;
const CAPTURE_WINDOW_HEIGHT = 460;

/**
 * How long to wait for the user to press the arm button in the legacy fallback.
 * The browser's own share picker sits inside this window, so it must be generous.
 */
const ARM_TIMEOUT_MS = 180_000;

type DisplayCaptureResult = {
  sessionId: string;
  ok: boolean;
  firstFrameAt?: number | null;
  cancelled?: boolean;
  error?: string;
  surface?: CapturedSurface;
};

export class ExtensionPageMediaHost implements MediaHost {
  readonly kind = "extension-page" as const;
  #activeSessionId: string | null = null;
  #stopPromiseResolve: (() => void) | null = null;
  #stopTimeoutId: ReturnType<typeof setTimeout> | null = null;
  #mediaTabId: number | null = null;
  #mediaWindowId: number | null = null;
  /** What the user actually shared / how frames were sourced. */
  #capturedSurface: CapturedSurface = {};
  /** True when start used tab frames (no focus steal for share). */
  #usedTabFrames = false;

  get activeSessionId(): string | null {
    return this.#activeSessionId;
  }

  /** Empty until a capture has started; cleared by the next start. */
  get capturedSurface(): CapturedSurface {
    return this.#capturedSurface;
  }

  async startCapture(
    tabId: number,
    sessionId: string,
    options?: MediaStartCaptureOptions,
  ): Promise<number | null> {
    // Legacy: stream already adopted into this host (unused by current popup).
    if (options?.prearmed) {
      this.#activeSessionId = sessionId;
      this.#capturedSurface = options.capturedSurface ?? {};
      this.#usedTabFrames = false;
      return options.firstFrameAt ?? null;
    }

    this.#usedTabFrames = false;
    this.#capturedSurface = {};

    // Prefer getDisplayMedia (OS share picker). Auto-starts in the media host
    // without showing the arm-button panel first; tab-frame is last resort.
    try {
      return await this.#startDisplayCaptureArm(tabId, sessionId, options);
    } catch (displayError) {
      const message =
        displayError instanceof Error ? displayError.message : String(displayError ?? "");
      // User dismissed the picker — do not silently start snapshot capture.
      if (/cancell?ed/i.test(message)) {
        throw displayError;
      }
      console.warn(
        "[GN Tracing] Display capture unavailable, falling back to tab-frame snapshots:",
        displayError,
      );
    }

    return this.#startTabFrameCapture(tabId, sessionId, options);
  }

  /**
   * Capture the recorded tab via tabs.captureTab → canvas.captureStream.
   * No user picker; tab is selected by tabId from Start.
   */
  async #startTabFrameCapture(
    tabId: number,
    sessionId: string,
    options?: MediaStartCaptureOptions,
  ): Promise<number | null> {
    await this.ensurePackagingContext({ focused: false });
    await this.#minimizeCaptureWindow();

    const response = (await chrome.runtime.sendMessage({
      target: MEDIA_PAGE_MESSAGE_TARGET,
      type: "START_TAB_FRAME_CAPTURE",
      data: {
        tabId,
        sessionId,
        microphoneDeviceId: options?.microphoneDeviceId ?? "",
        speakerDeviceId: options?.speakerDeviceId ?? "",
      },
    })) as
      | {
          ok?: boolean;
          error?: string;
          data?: {
            firstFrameAt?: number | null;
            surface?: CapturedSurface;
          };
        }
      | undefined;

    if (!response?.ok) {
      throw new Error(
        response?.error || "Could not start tab-frame capture on the media host page.",
      );
    }

    this.#activeSessionId = sessionId;
    this.#capturedSurface = response.data?.surface ?? {
      displaySurface: "browser",
      label: "Recorded tab",
    };
    this.#usedTabFrames = true;
    return response.data?.firstFrameAt ?? null;
  }

  /**
   * getDisplayMedia path: focus capture window, auto-open OS share picker, wait.
   * Arm buttons stay hidden unless the engine requires a gesture in this document.
   */
  async #startDisplayCaptureArm(
    tabId: number,
    sessionId: string,
    options?: MediaStartCaptureOptions,
  ): Promise<number | null> {
    await this.ensurePackagingContext({ focused: true });

    const tabTitle = await this.#readTabTitle(tabId);
    const armed = this.#waitForDisplayCaptureResult(sessionId);

    try {
      await this.#focusCaptureWindow();

      const ack = (await chrome.runtime.sendMessage({
        target: MEDIA_PAGE_MESSAGE_TARGET,
        type: "ARM_DISPLAY_CAPTURE",
        data: {
          sessionId,
          tabTitle,
          microphoneDeviceId: options?.microphoneDeviceId ?? "",
          speakerDeviceId: options?.speakerDeviceId ?? "",
        },
      })) as { ok?: boolean; error?: string } | undefined;

      if (!ack?.ok) {
        throw new Error(
          ack?.error || "Could not reach the GN Tracing capture window. Close it and try again.",
        );
      }

      const result = await armed.promise;
      if (!result.ok) {
        throw new Error(
          result.error || "Screen sharing was cancelled, so recording did not start.",
        );
      }

      this.#activeSessionId = sessionId;
      this.#capturedSurface = result.surface ?? {};
      this.#usedTabFrames = false;
      return result.firstFrameAt ?? null;
    } catch (error) {
      await this.#cancelArm();
      throw error;
    } finally {
      armed.dispose();
    }
  }

  /**
   * After share-picker fallback, minimize capture window and return focus.
   * Tab-frame path never steals focus, so this is a no-op minimize only.
   */
  async restoreRecordedTabFocus(tabId: number): Promise<void> {
    if (this.#usedTabFrames) {
      await this.#minimizeCaptureWindow();
      return;
    }
    await this.#restoreFocus(tabId);
  }

  /** Resolve on the page's DISPLAY_CAPTURE_RESULT for this session, or time out. */
  #waitForDisplayCaptureResult(sessionId: string): {
    promise: Promise<DisplayCaptureResult>;
    dispose: () => void;
  } {
    let listener: Parameters<typeof chrome.runtime.onMessage.addListener>[0] | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    const dispose = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (listener) {
        chrome.runtime.onMessage.removeListener(listener);
        listener = null;
      }
    };

    const promise = new Promise<DisplayCaptureResult>((resolve, reject) => {
      listener = (message: unknown) => {
        const candidate = message as {
          target?: unknown;
          type?: unknown;
          data?: unknown;
        };
        if (
          candidate?.target !== MEDIA_PAGE_MESSAGE_TARGET ||
          candidate?.type !== "DISPLAY_CAPTURE_RESULT"
        ) {
          return undefined;
        }
        const data = candidate.data as DisplayCaptureResult | undefined;
        if (!data || data.sessionId !== sessionId || settled) {
          return undefined;
        }
        settled = true;
        dispose();
        resolve(data);
        return undefined;
      };
      chrome.runtime.onMessage.addListener(listener);

      timeoutId = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        dispose();
        reject(new Error(describeFirefoxArmTimeoutMessage()));
      }, ARM_TIMEOUT_MS);
    });

    return { promise, dispose };
  }

  async #readTabTitle(tabId: number): Promise<string> {
    try {
      const tab = await chrome.tabs.get(tabId);
      return typeof tab.title === "string" ? tab.title : "";
    } catch {
      return "";
    }
  }

  async #focusCaptureWindow(): Promise<void> {
    if (this.#mediaWindowId === null) {
      return;
    }
    try {
      await chrome.windows.update(this.#mediaWindowId, {
        focused: true,
        state: "normal",
      });
    } catch {
      // Window vanished; the ARM message will fail and surface a clear error.
    }
  }

  async #minimizeCaptureWindow(): Promise<void> {
    if (this.#mediaWindowId === null) {
      return;
    }
    try {
      await chrome.windows.update(this.#mediaWindowId, {
        state: "minimized",
        focused: false,
      });
    } catch {
      // Non-fatal.
    }
  }

  async #restoreFocus(tabId: number): Promise<void> {
    await this.#minimizeCaptureWindow();
    try {
      const tab = await chrome.tabs.update(tabId, { active: true });
      if (typeof tab?.windowId === "number") {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
    } catch {
      // The recorded tab may have been closed; capture is still running.
    }
  }

  async #cancelArm(): Promise<void> {
    try {
      await chrome.runtime.sendMessage({
        target: MEDIA_PAGE_MESSAGE_TARGET,
        type: "CANCEL_DISPLAY_CAPTURE",
      });
    } catch {
      // Page already closed.
    }
    await this.#minimizeCaptureWindow();
  }

  async stopCapture(discard = false): Promise<void> {
    try {
      const stopPromise = new Promise<void>((resolve) => {
        this.#stopPromiseResolve = resolve;
        this.#stopTimeoutId = setTimeout(() => {
          this.#stopTimeoutId = null;
          this.#stopPromiseResolve = null;
          resolve();
        }, 3000);
      });

      await chrome.runtime.sendMessage({
        target: MEDIA_PAGE_MESSAGE_TARGET,
        type: discard ? "DISCARD_CAPTURE" : "STOP_CAPTURE",
      });

      await stopPromise;
    } catch {
      // Media page may already be closed.
    }
  }

  onRecordingComplete(sessionId?: string): void {
    if (this.#activeSessionId && sessionId && sessionId !== this.#activeSessionId) {
      return;
    }

    if (this.#stopTimeoutId) {
      clearTimeout(this.#stopTimeoutId);
      this.#stopTimeoutId = null;
    }

    if (this.#stopPromiseResolve) {
      this.#stopPromiseResolve();
      this.#stopPromiseResolve = null;
    }
  }

  clearActiveSession(): void {
    this.#activeSessionId = null;
    this.#usedTabFrames = false;
  }

  hydrateActiveSession(sessionId: string | null): void {
    this.#activeSessionId = sessionId;
  }

  /**
   * Ensure a DOM-capable extension page exists for packaging / capture.
   *
   * Uses a popup window (not a browser tab) so full-record never steals a slot
   * in the user's tab strip.
   */
  async ensurePackagingContext(options?: { focused?: boolean }): Promise<void> {
    const focused = Boolean(options?.focused);
    const pageUrl = chrome.runtime.getURL(MEDIA_PAGE_PATH);

    if (await this.#bindExistingMediaHost(pageUrl)) {
      if (focused) {
        await this.#focusCaptureWindow();
      }
      return;
    }

    const created = await chrome.windows.create({
      url: pageUrl,
      type: "popup",
      width: CAPTURE_WINDOW_WIDTH,
      height: CAPTURE_WINDOW_HEIGHT,
      focused,
    });

    if (typeof created?.id !== "number") {
      throw new Error("Could not open the media host window for packaging/capture.");
    }
    this.#mediaWindowId = created.id;

    const tabId = created.tabs?.[0]?.id;
    if (typeof tabId === "number") {
      this.#mediaTabId = tabId;
    } else {
      const matches = await chrome.tabs.query({ windowId: created.id });
      const first = matches.find((tab) => typeof tab.id === "number");
      if (first?.id == null) {
        throw new Error("Could not open the media host window for packaging/capture.");
      }
      this.#mediaTabId = first.id;
    }

    await this.#waitUntilMediaPageReady();
  }

  async #bindExistingMediaHost(pageUrl: string): Promise<boolean> {
    if (this.#mediaTabId !== null) {
      try {
        const tab = await chrome.tabs.get(this.#mediaTabId);
        if (tab?.id != null && (tab.url === pageUrl || tab.url?.startsWith(pageUrl))) {
          if (typeof tab.windowId === "number") {
            this.#mediaWindowId = tab.windowId;
          }
          return true;
        }
      } catch {
        this.#mediaTabId = null;
        this.#mediaWindowId = null;
      }
    }

    const existing = await chrome.tabs.query({});
    const open = existing.find(
      (tab) =>
        typeof tab.id === "number" &&
        typeof tab.url === "string" &&
        (tab.url === pageUrl || tab.url.startsWith(pageUrl)),
    );
    if (open?.id != null) {
      this.#mediaTabId = open.id;
      if (typeof open.windowId === "number") {
        this.#mediaWindowId = open.windowId;
      }
      return true;
    }

    return false;
  }

  async #waitUntilMediaPageReady(timeoutMs = 3_000): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      try {
        const ack = (await chrome.runtime.sendMessage({
          target: MEDIA_PAGE_MESSAGE_TARGET,
          type: "MEDIA_HOST_PING",
        })) as { ok?: boolean } | undefined;
        if (ack?.ok) {
          return;
        }
      } catch {
        // Page still loading.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async cleanup(): Promise<void> {
    if (this.#stopTimeoutId) {
      clearTimeout(this.#stopTimeoutId);
      this.#stopTimeoutId = null;
    }
    this.#stopPromiseResolve = null;
    this.#activeSessionId = null;
    this.#usedTabFrames = false;

    try {
      await chrome.runtime.sendMessage({
        target: MEDIA_PAGE_MESSAGE_TARGET,
        type: "DISCARD_CAPTURE",
      });
    } catch {
      // Ignore.
    }

    await this.#closeCaptureWindow();
  }

  async #closeCaptureWindow(): Promise<void> {
    const windowId = this.#mediaWindowId;
    this.#mediaWindowId = null;
    this.#mediaTabId = null;
    if (windowId === null) {
      return;
    }
    try {
      await chrome.windows.remove(windowId);
    } catch {
      // Already closed.
    }
  }
}
