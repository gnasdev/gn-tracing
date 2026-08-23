/**
 * iOS/iPadOS Safari reduced-capture path: in-page evidence only, no video.
 *
 * iOS Safari exposes no screen/tab capture API to extension JS at all — no
 * getDisplayMedia, no ReplayKit bridge (confirmed stable through iOS 17/18).
 * There is therefore no `MediaHost` on this path (`mediaKind = "none"`) and no
 * fallback to attempt: this is a permanent platform limit, not a temporary gap.
 *
 * Because there is no `WebRequestNetworkCollector` in the `CollectorSet` here,
 * `InPageEvidenceCollector` is constructed with `captureNetwork: true` and is
 * the sole source of network evidence — unlike the Firefox/macOS Safari path,
 * `ingestEvidenceEntry` must NOT drop `kind === "network"` here.
 */

import type { StorageManager } from "../../background/storage-manager";
import type {
  ConsoleEntry,
  NetworkEntry,
  StorageSnapshot,
  WebSocketEntry,
} from "../../types/recording";
import { CollectorSet } from "../evidence/collector-set";
import { InPageEvidenceCollector } from "../evidence/in-page-collector";
import type {
  EvidenceEntry,
  RecordingFinalizeInput,
  RecordingFinalizeResult,
  RecordingRuntime,
  RecordingStartInput,
} from "./types";

const NO_VIDEO_LIMITATION =
  "Video is not available on iOS/iPadOS Safari. This recording captures " +
  "console, network metadata, and interaction events only.";

export class SafariIosRecordingRuntime implements RecordingRuntime {
  readonly mediaKind = "none" as const;
  readonly #storage: StorageManager;
  readonly #evidence: CollectorSet;
  #sessionId: string | null = null;
  #attachLimitations: string[] = [];

  constructor(storage: StorageManager) {
    this.#storage = storage;
    this.#evidence = new CollectorSet([new InPageEvidenceCollector({ captureNetwork: true })]);
  }

  get activeSessionId(): string | null {
    return this.#sessionId;
  }

  async start(input: RecordingStartInput): Promise<{ firstFrameAt: number | null }> {
    this.#storage.setCaptureSettings(input.settings);
    this.#storage.setPrivacySettings(input.privacySettings, input.onRedactionHits);

    this.#sessionId = input.sessionId;

    const attached = await this.#evidence.attach({
      tabId: input.tabId,
      sessionId: input.sessionId,
    });
    this.#attachLimitations = [...attached.limitations];
    if (!attached.ok) {
      throw new Error(attached.limitations[0] ?? "Evidence capture could not attach.");
    }

    const armed = await this.#evidence.beginSession({
      tabId: input.tabId,
      sessionId: input.sessionId,
    });
    this.#attachLimitations.push(...armed.limitations);

    // No media to start; there is never a first frame on this path.
    return { firstFrameAt: null };
  }

  async reinjectEvidenceCapture(tabId: number, sessionId: string): Promise<void> {
    if (this.#sessionId && sessionId !== this.#sessionId) {
      return;
    }
    await this.#evidence.reattach(tabId, sessionId);
  }

  stopMedia(): Promise<void> {
    return Promise.resolve();
  }

  async finalizeEvidence(_input: RecordingFinalizeInput): Promise<RecordingFinalizeResult> {
    const { limitations: detachLimitations } = await this.#evidence.detach();
    this.#sessionId = null;
    return {
      evidenceCoverage: this.#evidence.evidenceCoverage,
      sourceMapDiagnostics: null,
      privacyLimitations: [...this.#attachLimitations, ...detachLimitations, NO_VIDEO_LIMITATION],
    };
  }

  async discard(): Promise<void> {
    await this.#evidence.detach();
    this.#sessionId = null;
  }

  onRecordingComplete(): void {
    // No media host to notify.
  }

  clearActiveSession(): void {
    this.#sessionId = null;
  }

  hydrateActiveSession(sessionId: string | null): void {
    this.#sessionId = sessionId;
  }

  ensurePackagingContext(): Promise<void> {
    // Packaging is DOM-free (packages/replay-core has no chrome.*/DOM
    // dependency), so there is no host page to prepare.
    return Promise.resolve();
  }

  closeMediaHostIfIdle(): Promise<void> {
    return Promise.resolve();
  }

  releaseSourceMaps(): void {
    // No CDP source maps on iOS Safari.
  }

  ingestEvidenceEntry(sessionId: string, kind: string, entry: EvidenceEntry): void {
    if (this.#sessionId && sessionId !== this.#sessionId) {
      return;
    }
    if (kind === "console") {
      this.#storage.addConsoleEntry(entry as ConsoleEntry);
      return;
    }
    // Sole network owner on this path: no webRequest collector exists here.
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
    // No CDP DOM snapshots on iOS Safari.
  }
}
