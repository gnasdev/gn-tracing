/**
 * Firefox network evidence via webRequest, as an EvidenceCollector.
 *
 * webRequest is Firefox's answer to CDP's Network domain: full-tab, all-frames
 * visibility including requests the browser issues itself (document, images,
 * stylesheets, fonts) that in-page capture cannot see (see
 * InPageEvidenceCollector's networkGapLimitation). This collector is
 * observe-only — no `filterResponseData`, no response bodies, no blocking —
 * which keeps the risk of stalling a page's real requests at zero. That is a
 * deliberate scope cut (phase 2 of the Firefox evidence plan); response bodies
 * are a separate, higher-risk phase.
 *
 * Listeners are registered once at module scope in `install()`, not inside
 * attach(). Firefox's background is an event page that the browser can unload
 * and re-evaluate from scratch, and `chrome.webRequest.onBeforeRequest` only
 * fires for listeners added synchronously when the script runs — a listener
 * added inside an async attach() call can miss events fired before that
 * promise resolves, and is exactly the kind of "works most of the time" bug
 * this session spent hours chasing elsewhere. Session-scoping happens inside
 * the listener via `#sessionId`, not by attaching/detaching the listener itself.
 */

import type { RecordingCapability } from "../../../../packages/replay-core/src/schema/package";
import type { StorageManager } from "../../../background/storage-manager";
import type {
  EvidenceAttachInput,
  EvidenceAttachResult,
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

  constructor(storage: StorageManager) {
    this.#storage = storage;
  }

  async attach(input: EvidenceAttachInput): Promise<EvidenceAttachResult> {
    this.#sessionId = input.sessionId;
    this.#tabId = input.tabId;

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
    return {
      ok: true,
      capabilities: NETWORK_CAPABILITIES,
      limitations: [
        "Network evidence observes requests only; response bodies are not captured " +
          "on this browser.",
      ],
    };
  }

  async detach(): Promise<EvidenceDetachResult> {
    const incomplete = this.#table.drainIncomplete();
    for (const entry of incomplete) {
      this.#storage.addNetworkEntry(entry);
    }
    this.#sessionId = null;
    this.#tabId = null;
    // Listeners stay installed: webRequest.onBeforeRequest only fires for
    // listeners present when the browser dispatches the event, and removing
    // them here would have to re-add them on the next attach from inside an
    // async call — the exact ordering hazard this collector exists to avoid.
    return { limitations: [] };
  }

  async reattach(tabId: number, sessionId: string): Promise<void> {
    // webRequest is not injected per-frame like content scripts; it observes
    // at the browser level and survives navigation on its own.
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
