/**
 * Firefox media host: reuses offscreen/offscreen.html as a normal extension tab.
 *
 * Firefox has no chrome.offscreen / chrome.tabCapture. Video uses
 * getDisplayMedia inside that page after the user starts recording. Packaging
 * and upload stay in the same document code path as Chromium.
 */

import { MEDIA_PAGE_MESSAGE_TARGET } from "./message-target";
import type { MediaHost } from "./types";

/** Same HTML/JS as Chromium offscreen document — opened as a tab on Firefox. */
const MEDIA_PAGE_PATH = "offscreen/offscreen.html";

export class ExtensionPageMediaHost implements MediaHost {
  readonly kind = "extension-page" as const;
  #activeSessionId: string | null = null;
  #stopPromiseResolve: (() => void) | null = null;
  #stopTimeoutId: ReturnType<typeof setTimeout> | null = null;
  #mediaTabId: number | null = null;

  get activeSessionId(): string | null {
    return this.#activeSessionId;
  }

  async startCapture(_tabId: number, sessionId: string): Promise<number | null> {
    await this.ensurePackagingContext();

    const response = (await chrome.runtime.sendMessage({
      target: MEDIA_PAGE_MESSAGE_TARGET,
      type: "START_CAPTURE",
      data: { sessionId, mode: "display-media" },
    })) as { ok: boolean; data?: { firstFrameAt?: number | null }; error?: string } | undefined;

    if (!response?.ok) {
      throw new Error(
        response?.error ||
          "Failed to start display capture. Allow tab/window sharing when the browser prompts.",
      );
    }

    this.#activeSessionId = sessionId;
    return response.data?.firstFrameAt ?? null;
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
      // Do not steal focus from the page under test; getDisplayMedia still prompts.
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
