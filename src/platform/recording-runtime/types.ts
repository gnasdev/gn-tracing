/**
 * Uniform full-record runtime: evidence capture + media packaging host.
 *
 * Browser differences stay inside implementations. The service worker only
 * calls start / stopMedia / finalizeEvidence / discard — no mode switches.
 */

import type { EvidenceCoverage } from "../../../packages/replay-core/src/schema/package";
import type { UploadSettingsStore } from "../../background/settings-store";
import type { PrivacyRedactionSettings } from "../../types/messages";
import type {
  ConsoleEntry,
  NetworkEntry,
  RedactionHit,
  SourceMapDiagnostic,
  StorageSnapshot,
  WebSocketEntry,
} from "../../types/recording";
import type { MediaHostKind } from "../types";

export type EvidenceEntry = ConsoleEntry | NetworkEntry | WebSocketEntry | StorageSnapshot;

export interface RecordingStartInput {
  tabId: number;
  sessionId: string;
  settings: UploadSettingsStore;
  privacySettings: PrivacyRedactionSettings;
  onRedactionHits: (hits: RedactionHit[]) => void;
  /**
   * Firefox legacy: stream already adopted into the media host. Skip focusing
   * the capture tab / arm panel. Current popup does not set this.
   */
  mediaPrearmed?: boolean;
  firstFrameAt?: number | null;
  capturedSurface?: import("../../media-pipeline/capture-surface").CapturedSurface;
}

export interface RecordingFinalizeInput {
  captureStorage: boolean;
  captureDomSnapshots: boolean;
  stopTime: number;
}

export interface RecordingFinalizeResult {
  /** Built diagnostics artifact fields (source maps), or null when none. */
  sourceMapDiagnostics: {
    schemaVersion: 1;
    generatedAt: string;
    sourceMaps: SourceMapDiagnostic[];
  } | null;
  evidenceCoverage: EvidenceCoverage;
  privacyLimitations: string[];
}

export interface RecordingRuntime {
  readonly mediaKind: MediaHostKind;

  start(input: RecordingStartInput): Promise<{ firstFrameAt: number | null }>;

  /** Stop or discard MediaRecorder; does not detach evidence collectors yet. */
  stopMedia(discard?: boolean): Promise<void>;

  /**
   * After media stop: storage/DOM snapshots, source-map flush, detach evidence.
   * Applies source-map resolution into the shared StorageManager when CDP ran.
   */
  finalizeEvidence(input: RecordingFinalizeInput): Promise<RecordingFinalizeResult>;

  /** Abort an in-flight session (media + evidence). */
  discard(): Promise<void>;

  onRecordingComplete(sessionId?: string): void;

  clearActiveSession(): void;

  hydrateActiveSession(sessionId: string | null): void;

  get activeSessionId(): string | null;

  ensurePackagingContext(): Promise<void>;

  /** Close offscreen/media host when idle (Chromium tears down offscreen). */
  closeMediaHostIfIdle(): Promise<void>;

  /** Best-effort source-map release after discard/error paths. */
  releaseSourceMaps(): void;

  /**
   * Bridge in-page capture entries into storage. No-op on Chromium.
   * Always present so the service worker never casts the runtime.
   */
  ingestEvidenceEntry(sessionId: string, kind: string, entry: EvidenceEntry): void;

  /**
   * Re-arm evidence capture after the recorded tab navigated.
   *
   * Firefox injects content scripts that a navigation destroys, so they must be put
   * back or the rest of the recording has no console/network evidence. Chromium
   * keeps evidence on CDP, which survives navigation, so it is a no-op there.
   */
  reinjectEvidenceCapture(tabId: number, sessionId: string): Promise<void>;

  /** Optional CDP DOM snapshot at discrete markers (e.g. navigation). No-op without CDP. */
  captureDomSnapshotMarker(label: string): Promise<void>;
}
