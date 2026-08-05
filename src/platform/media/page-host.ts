/**
 * Firefox media host: reuses offscreen/offscreen.html as a normal extension tab.
 *
 * Firefox has no chrome.offscreen / chrome.tabCapture. Video uses
 * getDisplayMedia inside that page, which Firefox only allows while the document
 * holds transient user activation — so the page is focused and the user clicks
 * "Share this tab" there. Packaging and upload stay in the same document code
 * path as Chromium.
 */

import type { CapturedSurface } from "../../media-pipeline/capture-surface";
import { MEDIA_PAGE_MESSAGE_TARGET } from "./message-target";
import type { MediaHost } from "./types";

/** Same HTML/JS as Chromium offscreen document — opened as a tab on Firefox. */
const MEDIA_PAGE_PATH = "offscreen/offscreen.html";

/**
 * How long to wait for the user to press "Share this tab" in the media page.
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
  /** What the user actually shared, reported by the media page after the picker. */
  #capturedSurface: CapturedSurface = {};

  get activeSessionId(): string | null {
    return this.#activeSessionId;
  }

  /** Empty until a display capture has started; cleared by the next start. */
  get capturedSurface(): CapturedSurface {
    return this.#capturedSurface;
  }

  async startCapture(tabId: number, sessionId: string): Promise<number | null> {
    await this.ensurePackagingContext();

    // getDisplayMedia requires transient user activation, which a background
    // message cannot provide. So the media page is focused and asks the user to
    // click; that click is what actually opens the browser's share picker.
    const tabTitle = await this.#readTabTitle(tabId);
    const armed = this.#waitForDisplayCaptureResult(sessionId);

    try {
      await this.#focusMediaTab();

      const ack = (await chrome.runtime.sendMessage({
        target: MEDIA_PAGE_MESSAGE_TARGET,
        type: "ARM_DISPLAY_CAPTURE",
        data: { sessionId, tabTitle },
      })) as { ok?: boolean; error?: string } | undefined;

      if (!ack?.ok) {
        throw new Error(
          ack?.error || "Could not reach the GN Tracing capture tab. Close it and try again.",
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
      // Hand focus back to the tab under test now that the stream is live.
      await this.#restoreFocus(tabId);
      return result.firstFrameAt ?? null;
    } catch (error) {
      await this.#cancelArm();
      throw error;
    } finally {
      armed.dispose();
    }
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
        const candidate = message as { target?: unknown; type?: unknown; data?: unknown };
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
        reject(
          new Error(
            "Timed out waiting for screen sharing to be allowed. " +
              "Start the recording again and press Share this tab.",
          ),
        );
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

  /** Bring the media page forward so its button can receive a real click. */
  async #focusMediaTab(): Promise<void> {
    if (this.#mediaTabId === null) {
      return;
    }
    try {
      const tab = await chrome.tabs.update(this.#mediaTabId, { active: true, pinned: false });
      if (typeof tab?.windowId === "number") {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
    } catch {
      // Tab vanished; the ARM message will fail and surface a clear error.
    }
  }

  /** Park the media page again and return the user to the recorded tab. */
  async #restoreFocus(tabId: number): Promise<void> {
    if (this.#mediaTabId !== null) {
      try {
        await chrome.tabs.update(this.#mediaTabId, { pinned: true });
      } catch {
        // Non-fatal cosmetic step.
      }
    }
    try {
      const tab = await chrome.tabs.update(tabId, { active: true });
      if (typeof tab?.windowId === "number") {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
    } catch {
      // The recorded tab may have been closed; capture is still running.
    }
  }

  /** Hide the arm panel after a failed or abandoned attempt. */
  async #cancelArm(): Promise<void> {
    try {
      await chrome.runtime.sendMessage({
        target: MEDIA_PAGE_MESSAGE_TARGET,
        type: "CANCEL_DISPLAY_CAPTURE",
      });
    } catch {
      // Page already closed.
    }
    if (this.#mediaTabId !== null) {
      try {
        await chrome.tabs.update(this.#mediaTabId, { pinned: true, active: false });
      } catch {
        // Ignore.
      }
    }
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
  }

  hydrateActiveSession(sessionId: string | null): void {
    this.#activeSessionId = sessionId;
  }

  async ensurePackagingContext(): Promise<void> {
    const pageUrl = chrome.runtime.getURL(MEDIA_PAGE_PATH);

    if (this.#mediaTabId !== null) {
      try {
        const tab = await chrome.tabs.get(this.#mediaTabId);
        if (tab?.id != null && (tab.url === pageUrl || tab.url?.startsWith(pageUrl))) {
          return;
        }
      } catch {
        this.#mediaTabId = null;
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
      return;
    }

    const created = await chrome.tabs.create({
      url: pageUrl,
      // Parked out of the way; startCapture focuses it only while arming, because
      // the share picker must be opened by a click in this document.
      active: false,
      pinned: true,
    });
    if (typeof created.id !== "number") {
      throw new Error("Could not open the media host page for packaging/capture.");
    }
    this.#mediaTabId = created.id;

    // Give the page a moment to register its message listener.
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  async cleanup(): Promise<void> {
    if (this.#stopTimeoutId) {
      clearTimeout(this.#stopTimeoutId);
      this.#stopTimeoutId = null;
    }
    this.#stopPromiseResolve = null;
    this.#activeSessionId = null;

    try {
      await chrome.runtime.sendMessage({
        target: MEDIA_PAGE_MESSAGE_TARGET,
        type: "DISCARD_CAPTURE",
      });
    } catch {
      // Ignore.
    }
  }
}
