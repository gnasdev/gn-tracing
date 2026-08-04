/**
 * Firefox full-record path: in-page evidence + extension-page getDisplayMedia.
 *
 * Does not construct CdpManager.
 */

import type { StorageManager } from "../../background/storage-manager";
import type {
  ConsoleEntry,
  NetworkEntry,
  StorageSnapshot,
  WebSocketEntry,
} from "../../types/recording";
import { ExtensionPageMediaHost } from "../media/page-host";
import type {
  EvidenceEntry,
  RecordingFinalizeInput,
  RecordingFinalizeResult,
  RecordingRuntime,
  RecordingStartInput,
} from "./types";

const MAIN_SCRIPT = "content/in-page-capture-main.js";
const BRIDGE_SCRIPT = "content/in-page-capture-bridge.js";

export class FirefoxRecordingRuntime implements RecordingRuntime {
  readonly mediaKind = "extension-page" as const;
  readonly #storage: StorageManager;
  readonly #media = new ExtensionPageMediaHost();
  #tabId: number | null = null;
  #sessionId: string | null = null;

  constructor(storage: StorageManager) {
    this.#storage = storage;
  }

  get activeSessionId(): string | null {
    return this.#media.activeSessionId;
  }

  async start(input: RecordingStartInput): Promise<{ firstFrameAt: number | null }> {
    this.#storage.setCaptureSettings(input.settings);
    this.#storage.setPrivacySettings(input.privacySettings, input.onRedactionHits);

    this.#tabId = input.tabId;
    this.#sessionId = input.sessionId;

    await chrome.scripting.executeScript({
      target: { tabId: input.tabId },
      files: [BRIDGE_SCRIPT],
      world: "ISOLATED",
    });
    await chrome.scripting.executeScript({
      target: { tabId: input.tabId },
      files: [MAIN_SCRIPT],
      world: "MAIN",
    });

    const [, firstFrameAt] = await Promise.all([
      chrome.tabs.sendMessage(input.tabId, {
        target: "in-page-capture",
        type: "START",
        sessionId: input.sessionId,
      }),
      this.#media.startCapture(input.tabId, input.sessionId),
    ]);

    this.#media.hydrateActiveSession(input.sessionId);
    return { firstFrameAt: firstFrameAt ?? null };
  }

  stopMedia(discard = false): Promise<void> {
    return this.#media.stopCapture(discard);
  }

  async finalizeEvidence(_input: RecordingFinalizeInput): Promise<RecordingFinalizeResult> {
    await this.#stopInPage();
    return { sourceMapDiagnostics: null, privacyLimitations: [] };
  }

  async discard(): Promise<void> {
    await Promise.allSettled([this.#media.stopCapture(true), this.#stopInPage()]);
    await this.#media.cleanup();
  }

  onRecordingComplete(sessionId?: string): void {
    this.#media.onRecordingComplete(sessionId);
  }

  clearActiveSession(): void {
    this.#media.clearActiveSession();
  }

  hydrateActiveSession(sessionId: string | null): void {
    this.#media.hydrateActiveSession(sessionId);
  }

  ensurePackagingContext(): Promise<void> {
    return this.#media.ensurePackagingContext();
  }

  async closeMediaHostIfIdle(): Promise<void> {
    // Keep the extension media tab; tearing it down mid-upload is harmful.
  }

  releaseSourceMaps(): void {
    // No CDP source maps on Firefox.
  }

  ingestEvidenceEntry(sessionId: string, kind: string, entry: EvidenceEntry): void {
    if (this.#sessionId && sessionId !== this.#sessionId) {
      return;
    }
    if (kind === "console") {
      this.#storage.addConsoleEntry(entry as ConsoleEntry);
      return;
    }
    if (kind === "network") {
      this.#storage.addNetworkEntry(entry as NetworkEntry);
      return;
    }
    if (kind === "websocket") {
      this.#storage.upsertWebSocketEntry(entry as WebSocketEntry);
      return;
    }
    if (kind === "storage") {
      this.#storage.setStorageSnapshot(entry as StorageSnapshot);
    }
  }

  async captureDomSnapshotMarker(_label: string): Promise<void> {
    // No CDP DOM snapshots on Firefox full record.
  }

  async #stopInPage(): Promise<void> {
    const tabId = this.#tabId;
    if (tabId != null) {
      // Bridge only resolves after MAIN cleanup + entry deliveries drain.
      const response = (await chrome.tabs
        .sendMessage(tabId, {
          target: "in-page-capture",
          type: "STOP",
        })
        .catch((error: Error) => ({
          ok: false,
          error: error?.message || "In-page stop failed",
        }))) as { ok?: boolean; error?: string } | undefined;

      if (response && response.ok === false) {
        // Timed-out drain still continues finalize; best-effort packaging.
        console.warn("[GN Tracing] In-page capture stop drain:", response.error);
      }
    }
    this.#tabId = null;
    this.#sessionId = null;
  }
}
