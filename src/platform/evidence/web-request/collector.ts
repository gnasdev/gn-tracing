/**
 * Firefox network evidence via webRequest, as an EvidenceCollector.
 *
 * webRequest is Firefox's answer to CDP's Network domain: full-tab, all-frames
 * visibility including requests the browser issues itself (document, images,
 * stylesheets, fonts) that in-page capture cannot see. This collector is
 * observe-only — no `filterResponseData`, no response bodies, no blocking —
 * which keeps the risk of stalling a page's real requests at zero. Response
 * bodies are a separate, higher-risk phase.
 *
 * Lifecycle:
 * - `attach` installs listeners once and checks the API is available. It does
 *   **not** set the recorded tab yet, so traffic during a cancelable share-
 *   picker step is not stored.
 * - `beginSession` scopes listeners to the committed tab/session.
 *
 * Listeners are registered once at module scope in `install()`, not inside
 * attach(). Firefox's background is an event page that the browser can unload
 * and re-evaluate from scratch, and `chrome.webRequest.onBeforeRequest` only
 * fires for listeners added synchronously when the script runs — a listener
 * added inside an async attach() call can miss events fired before that
 * promise resolves.
 */

import type { RecordingCapability } from "../../../../packages/replay-core/src/schema/package";
import type { StorageManager } from "../../../background/storage-manager";
import type {
  EvidenceAttachInput,
  EvidenceAttachResult,
  EvidenceBeginSessionInput,
  EvidenceCollector,
  EvidenceDetachResult,
} from "../types";
import { WebRequestTable } from "./request-table";

const NETWORK_CAPABILITIES: readonly RecordingCapability[] = ["network"];

const REQUEST_FILTER = { urls: ["<all_urls>"] };

export class WebRequestNetworkCollector implements EvidenceCollector {
  readonly id = "web-request";
  readonly provides = NETWORK_CAPABILITIES;
  readonly #storage: StorageManager;
  readonly #table = new WebRequestTable();
  #sessionId: string | null = null;
  #tabId: number | null = null;
  #listenersInstalled = false;
  #prepared = false;

  constructor(storage: StorageManager) {
    this.#storage = storage;
  }

  async attach(_input: EvidenceAttachInput): Promise<EvidenceAttachResult> {
    this.#prepared = false;
    this.#sessionId = null;
    this.#tabId = null;

    if (!this.#hasWebRequest()) {
      // Optional permission not granted, or an engine without webRequest.
      return {
        ok: false,
        capabilities: [],
        limitations: [
          "Network evidence needs the webRequest permission, which is not currently granted.",
        ],
      };
    }

    this.#installListenersOnce();
    this.#prepared = true;
    return {
      ok: true,
      capabilities: NETWORK_CAPABILITIES,
      limitations: [
        "Network evidence observes requests only; response bodies are not captured " +
          "on this browser.",
      ],
    };
  }

  async beginSession(input: EvidenceBeginSessionInput): Promise<{ limitations: string[] }> {
    if (!this.#prepared) {
      return { limitations: [] };
    }
    this.#tabId = input.tabId;
    this.#sessionId = input.sessionId;
    return { limitations: [] };
  }

  async detach(): Promise<EvidenceDetachResult> {
    const incomplete = this.#table.drainIncomplete();
    for (const entry of incomplete) {
      this.#storage.addNetworkEntry(entry);
    }
    this.#sessionId = null;
    this.#tabId = null;
    this.#prepared = false;
    // Listeners stay installed: webRequest.onBeforeRequest only fires for
    // listeners present when the browser dispatches the event, and removing
    // them here would have to re-add them on the next attach from inside an
    // async call — the exact ordering hazard this collector exists to avoid.
    return { limitations: [] };
  }

  async reattach(tabId: number, sessionId: string): Promise<void> {
    // webRequest listeners survive navigation; only retarget the recorded tab.
    if (!this.#prepared && this.#hasWebRequest()) {
      this.#installListenersOnce();
      this.#prepared = true;
    }
    this.#tabId = tabId;
    this.#sessionId = sessionId;
  }

  /** True once for the lifetime of the background script, not per session. */
  #installListenersOnce(): void {
    if (this.#listenersInstalled) {
      return;
    }
    this.#listenersInstalled = true;

    chrome.webRequest.onBeforeRequest.addListener(
      (details) => this.#forTab(details, () => this.#table.onBeforeRequest(details)),
      REQUEST_FILTER,
    );
    chrome.webRequest.onSendHeaders.addListener(
      (details) => this.#forTab(details, () => this.#table.onSendHeaders(details)),
      REQUEST_FILTER,
      ["requestHeaders"],
    );
    chrome.webRequest.onHeadersReceived.addListener(
      (details) => this.#forTab(details, () => this.#table.onHeadersReceived(details)),
      REQUEST_FILTER,
      ["responseHeaders"],
    );
    chrome.webRequest.onCompleted.addListener(
      (details) =>
        this.#forTab(details, () => {
          const entry = this.#table.onCompleted(details);
          if (entry) {
            this.#storage.addNetworkEntry(entry);
          }
        }),
      REQUEST_FILTER,
      ["responseHeaders"],
    );
    chrome.webRequest.onErrorOccurred.addListener(
      (details) =>
        this.#forTab(details, () => {
          const entry = this.#table.onErrorOccurred(details);
          if (entry) {
            this.#storage.addNetworkEntry(entry);
          }
        }),
      REQUEST_FILTER,
    );
  }

  /** Only the recorded tab's traffic matters; everything else is noise (and a privacy leak if kept). */
  #forTab(details: { tabId?: number }, action: () => void): void {
    if (this.#tabId == null || details.tabId !== this.#tabId) {
      return;
    }
    action();
  }

  /**
   * A real browser never throws for a missing optional-permission namespace —
   * `chrome.webRequest` is simply `undefined`. Kept as its own method so the
   * check reads clearly at the call site.
   */
  #hasWebRequest(): boolean {
    return typeof chrome.webRequest !== "undefined";
  }
}
