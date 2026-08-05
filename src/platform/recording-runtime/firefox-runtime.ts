/**
 * Firefox full-record path: in-page evidence + extension-page getDisplayMedia.
 *
 * Does not construct CdpManager.
 */

import type { StorageManager } from "../../background/storage-manager";
import { describeCaptureSurfaceLimitation } from "../../media-pipeline/capture-surface";
import type { ConsoleEntry, StorageSnapshot, WebSocketEntry } from "../../types/recording";
import { CollectorSet } from "../evidence/collector-set";
import { InPageEvidenceCollector } from "../evidence/in-page-collector";
import { WebRequestNetworkCollector } from "../evidence/web-request/collector";
import { ExtensionPageMediaHost } from "../media/page-host";
import type {
  EvidenceEntry,
  RecordingFinalizeInput,
  RecordingFinalizeResult,
  RecordingRuntime,
  RecordingStartInput,
} from "./types";

export class FirefoxRecordingRuntime implements RecordingRuntime {
  readonly mediaKind = "extension-page" as const;
  readonly #storage: StorageManager;
  readonly #media = new ExtensionPageMediaHost();
  readonly #evidence: CollectorSet;
  #tabId: number | null = null;
  #sessionId: string | null = null;
  /** Limitations from the most recent attach; merged into finalize's result. */
  #attachLimitations: string[] = [];

  constructor(storage: StorageManager) {
    this.#storage = storage;
    this.#evidence = new CollectorSet([
      new InPageEvidenceCollector(),
      new WebRequestNetworkCollector(storage),
    ]);
  }

  get activeSessionId(): string | null {
    return this.#media.activeSessionId;
  }

  async start(input: RecordingStartInput): Promise<{ firstFrameAt: number | null }> {
    this.#storage.setCaptureSettings(input.settings);
    this.#storage.setPrivacySettings(input.privacySettings, input.onRedactionHits);

    this.#tabId = input.tabId;
    this.#sessionId = input.sessionId;

    // Attach while the tab still holds activeTab: startCapture below focuses
    // the media host tab, which revokes it. A resolved executeScript is not
    // proof the script ran on Firefox, so the collector inspects the outcome
    // rather than discarding it.
    const attached = await this.#evidence.attach({
      tabId: input.tabId,
      sessionId: input.sessionId,
      responseBodyMode: input.settings.captureResponseBodyMode,
      maxResponseBodyBytes: input.settings.maxResponseBodyBytes,
    });
    this.#attachLimitations = [...attached.limitations];
    if (!attached.ok) {
      throw new Error(attached.limitations[0] ?? "In-page evidence capture could not attach.");
    }

    // Media first: it blocks on the user clicking "Choose what to share" (and on
    // the browser's share picker), and it is the step that can be cancelled.
    // Starting in-page evidence before that would capture the picker detour, and a
    // cancel would leave the page instrumented.
    const firstFrameAt = await this.#media.startCapture(input.tabId, input.sessionId);

    this.#media.hydrateActiveSession(input.sessionId);
    return { firstFrameAt: firstFrameAt ?? null };
  }

  /**
   * Re-arm evidence capture after the recorded tab navigated.
   *
   * A navigation destroys the injected scripts, and nothing used to put them back —
   * only user-event capture and the drawing overlay were re-armed. That is why a
   * recording on a dev server that reloads ended with an empty console.json and
   * "Receiving end does not exist" at stop.
   */
  async reinjectEvidenceCapture(tabId: number, sessionId: string): Promise<void> {
    if (this.#sessionId && sessionId !== this.#sessionId) {
      return;
    }
    await this.#evidence.reattach(tabId, sessionId);
  }

  stopMedia(discard = false): Promise<void> {
    return this.#media.stopCapture(discard);
  }

  async finalizeEvidence(_input: RecordingFinalizeInput): Promise<RecordingFinalizeResult> {
    const { limitations: detachLimitations } = await this.#evidence.detach();
    this.#tabId = null;
    this.#sessionId = null;
    const limitations: string[] = [...this.#attachLimitations, ...detachLimitations];

    // Firefox cannot capture a single tab, so the video always shows more than the
    // recorded page. Say which surface was shared instead of letting the viewer
    // assume a tab-scoped recording.
    const surfaceLimitation = describeCaptureSurfaceLimitation(this.#media.capturedSurface);
    if (surfaceLimitation) {
      limitations.push(surfaceLimitation);
    }

    return { sourceMapDiagnostics: null, privacyLimitations: limitations };
  }

  async discard(): Promise<void> {
    await Promise.allSettled([this.#media.stopCapture(true), this.#evidence.detach()]);
    this.#tabId = null;
    this.#sessionId = null;
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
    // No "network" branch: WebRequestNetworkCollector is the sole source of
    // network evidence on Firefox now (see InPageEvidenceCollector's
    // capability list). In-page capture's fetch/XHR patcher still runs — it is
    // shared with Instant Replay, which has no webRequest listener of its own —
    // but any "network" entry it posts here is intentionally dropped so a
    // request is never written twice.
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
}
