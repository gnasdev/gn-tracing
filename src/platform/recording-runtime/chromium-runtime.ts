/**
 * Chromium-family full-record path (Chrome / Edge / Opera):
 * CDP evidence + offscreen tabCapture media.
 */

import { CdpManager } from "../../background/cdp-manager";
import type { StorageManager } from "../../background/storage-manager";
import { CdpEvidenceCollector } from "../evidence/cdp-collector";
import { CollectorSet } from "../evidence/collector-set";
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
  readonly #evidence: CollectorSet;

  constructor(storage: StorageManager) {
    this.#storage = storage;
    this.#cdp = new CdpManager(storage);
    this.#evidence = new CollectorSet([new CdpEvidenceCollector(this.#cdp)]);
  }

  get activeSessionId(): string | null {
    return this.#media.activeSessionId;
  }

  async start(input: RecordingStartInput): Promise<{ firstFrameAt: number | null }> {
    this.#cdp.setCaptureSettings(input.settings);
    this.#cdp.setPrivacySettings(input.privacySettings, input.onRedactionHits);

    // Media first. Parallel CDP attach during getUserMedia stamps evidence
    // before video t=0; the player then shows those rows at negative relativeMs.
    const firstFrameAt = await this.#media.startCapture(input.tabId, input.sessionId, {
      microphoneEnabled: input.settings.microphoneEnabled,
      microphoneDeviceId: input.settings.microphoneDeviceId,
    });
    const evidence = await this.#evidence.attach({
      tabId: input.tabId,
      sessionId: input.sessionId,
    });
    if (!evidence.ok) {
      const details = evidence.limitations.join(" ");
      const guidance =
        "Chrome could not start debugging this tab. Close DevTools or another extension using the debugger, then try again." +
        (details ? ` ${details}` : "");
      throw new Error(guidance);
    }
    // CDP observes from attach; beginSession is a no-op on CdpEvidenceCollector
    // but kept so the runtime always uses the same two-phase collector API.
    await this.#evidence.beginSession({ tabId: input.tabId, sessionId: input.sessionId });

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
    const { limitations: privacyLimitations } = await this.#evidence.detach();

    const sourceMaps = this.#cdp.getSourceMapDiagnostics();
    this.#storage.resolveSourceMaps(this.#cdp.sourceMapResolver, sourceMaps);
    this.#cdp.releaseSourceMaps();

    const baseCoverage = this.#evidence.evidenceCoverage ?? {
      schemaVersion: 1 as const,
      surfaces: {},
    };
    const evidenceCoverage = {
      ...baseCoverage,
      surfaces: { ...baseCoverage.surfaces },
    };
    if (!input.captureStorage) delete evidenceCoverage.surfaces["storage-snapshot"];
    if (!input.captureDomSnapshots) delete evidenceCoverage.surfaces["dom-snapshot"];

    return {
      evidenceCoverage,
      privacyLimitations: [...privacyLimitations],
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
    await Promise.allSettled([this.#media.stopCapture(true), this.#evidence.detach()]);
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

  async reinjectEvidenceCapture(_tabId: number, _sessionId: string): Promise<void> {
    // CDP stays attached across navigations, so there is nothing to re-arm.
  }
  captureDomSnapshotMarker(label: string): Promise<void> {
    return this.#cdp.captureDomSnapshot(label);
  }
}
