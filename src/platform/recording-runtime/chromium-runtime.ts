/**
 * Chromium full-record path: CDP evidence + offscreen tabCapture media.
 */

import { CdpManager } from "../../background/cdp-manager";
import type { StorageManager } from "../../background/storage-manager";
import { OffscreenMediaHost } from "../media/offscreen-host";
import type {
  EvidenceEntry,
  RecordingFinalizeInput,
  RecordingFinalizeResult,
  RecordingRuntime,
  RecordingStartInput,
} from "./types";

export class ChromiumRecordingRuntime implements RecordingRuntime {
  readonly mediaKind = "offscreen" as const;
  readonly #storage: StorageManager;
  readonly #cdp: CdpManager;
  readonly #media = new OffscreenMediaHost();

  constructor(storage: StorageManager) {
    this.#storage = storage;
    this.#cdp = new CdpManager(storage);
  }

  get activeSessionId(): string | null {
    return this.#media.activeSessionId;
  }

  async start(input: RecordingStartInput): Promise<{ firstFrameAt: number | null }> {
    this.#cdp.setCaptureSettings(input.settings);
    this.#cdp.setPrivacySettings(input.privacySettings, input.onRedactionHits);

    const [, firstFrameAt] = await Promise.all([
      this.#cdp.attach(input.tabId),
      this.#media.startCapture(input.tabId, input.sessionId),
    ]);

    if (input.settings.captureStorage) {
      await this.#cdp.captureStorageSnapshot("start");
    }
    if (input.settings.captureDomSnapshots) {
      await this.#cdp.captureDomSnapshot("start");
    }

    this.#media.hydrateActiveSession(input.sessionId);
    return { firstFrameAt };
  }

  stopMedia(discard = false): Promise<void> {
    return this.#media.stopCapture(discard);
  }

  async finalizeEvidence(input: RecordingFinalizeInput): Promise<RecordingFinalizeResult> {
    await this.#cdp.flushSourceMaps();
    if (input.captureStorage) {
      await this.#cdp.captureStorageSnapshot("stop");
    }
    if (input.captureDomSnapshots) {
      await this.#cdp.captureDomSnapshot("stop");
    }
    const privacyLimitations = this.#cdp.getStorageLimitations();
    try {
      await this.#cdp.detach();
    } catch {
      // Capture already stopped.
    }

    const sourceMaps = this.#cdp.getSourceMapDiagnostics();
    this.#storage.resolveSourceMaps(this.#cdp.sourceMapResolver, sourceMaps);
    this.#cdp.releaseSourceMaps();

    return {
      privacyLimitations,
      sourceMapDiagnostics:
        sourceMaps.length === 0
          ? null
          : {
              schemaVersion: 1,
              generatedAt: new Date(input.stopTime).toISOString(),
              sourceMaps,
            },
    };
  }

  async discard(): Promise<void> {
    await Promise.allSettled([this.#media.stopCapture(true), this.#cdp.detach()]);
    this.releaseSourceMaps();
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
    await this.#media.cleanup();
  }

  releaseSourceMaps(): void {
    try {
      this.#cdp.releaseSourceMaps();
    } catch {
      // ignore
    }
  }

  ingestEvidenceEntry(_sessionId: string, _kind: string, _entry: EvidenceEntry): void {
    // CDP path — entries arrive via debugger, not content-bridge messages.
  }

  captureDomSnapshotMarker(label: string): Promise<void> {
    return this.#cdp.captureDomSnapshot(label);
  }
}
