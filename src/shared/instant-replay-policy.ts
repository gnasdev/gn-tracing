/**
 * Pure Instant Replay policies shared by the content script, service worker,
 * and player bridge. Kept free of chrome.* so unit tests can drive the real
 * shipped functions without a browser.
 */

import type {
  InstantReplayArtifact,
  InstantReplayFrame,
} from "../../packages/replay-core/src/schema/annotation";
import type {
  DomArtifact,
  DomNode,
  DomSnapshot,
} from "../../packages/replay-core/src/schema/capture";
import type { UploadHistoryEntry } from "../types/messages";
import type { StorageProviderId } from "./storage-provider";

/** Snapshot the buffer without discarding it. */
export const COLLECT_INSTANT_REPLAY_ACTION = "COLLECT_INSTANT_REPLAY" as const;
/** Clear the buffer only after a successful package upload. */
export const COMMIT_INSTANT_REPLAY_ACTION = "COMMIT_INSTANT_REPLAY" as const;

/**
 * Collect must never clear the page buffer. Clearing happens only on an
 * explicit commit after upload succeeds, so a failed still/upload can retry.
 */
export function shouldClearBufferOnCollect(): boolean {
  return false;
}

/**
 * Whether the content script should clear after handling a message action.
 */
export function shouldClearBufferOnAction(action: string | undefined): boolean {
  return action === COMMIT_INSTANT_REPLAY_ACTION;
}

/**
 * Retention policy: the rolling window is enforced by the buffer on each push.
 * A hard full wipe on a fixed short interval is forbidden when the configured
 * window can be longer (15–300s) — that would silently discard lookback the
 * user asked to keep.
 */
export function allowHardFullBufferPurgeInterval(
  configuredWindowMs: number,
  purgeIntervalMs: number,
): boolean {
  if (!Number.isFinite(configuredWindowMs) || configuredWindowMs <= 0) {
    return false;
  }
  if (!Number.isFinite(purgeIntervalMs) || purgeIntervalMs <= 0) {
    return false;
  }
  // Only allow a full wipe cadence that is at least the configured window
  // (plus a small slack). A 120s wipe against a 300s window is rejected.
  return purgeIntervalMs >= configuredWindowMs;
}

export function hasInstantReplayFrames(
  artifact: InstantReplayArtifact | null | undefined,
): artifact is InstantReplayArtifact {
  return Boolean(artifact && Array.isArray(artifact.frames) && artifact.frames.length > 0);
}

/**
 * Map Instant Replay DOM frames onto the DomArtifact shape the player Elements
 * tab already renders. Labels keep the relative offset so the snapshot selector
 * reads as a lookback timeline.
 */
export function mapInstantReplayToDomArtifact(artifact: InstantReplayArtifact): DomArtifact {
  const snapshots: DomSnapshot[] = artifact.frames.map((frame, index) =>
    frameToDomSnapshot(frame, index),
  );
  return { schemaVersion: 1, snapshots };
}

function frameToDomSnapshot(frame: InstantReplayFrame, index: number): DomSnapshot {
  const seconds = Math.round((frame.relativeMs || 0) / 100) / 10;
  return {
    label: `instant-replay:+${seconds}s`,
    capturedAt: frame.capturedAt,
    documentUrl: frame.documentUrl || "",
    root: (frame.root ?? { nodeType: 9, nodeName: "#document" }) as DomNode,
  };
}

/**
 * Prefer Instant Replay frames for Elements when present; append ordinary
 * dom.json snapshots so start/stop markers remain available.
 */
export function resolveDomArtifactForPlayer(input: {
  dom?: DomArtifact | null;
  instantReplay?: InstantReplayArtifact | null;
}): DomArtifact | null {
  const fromIr = hasInstantReplayFrames(input.instantReplay)
    ? mapInstantReplayToDomArtifact(input.instantReplay)
    : null;
  const fromDom =
    input.dom && Array.isArray(input.dom.snapshots) && input.dom.snapshots.length > 0
      ? input.dom
      : null;

  if (fromIr && fromDom) {
    return {
      schemaVersion: 1,
      snapshots: [...fromIr.snapshots, ...fromDom.snapshots],
    };
  }
  return fromIr ?? fromDom;
}

/**
 * True when the Elements tab should be offered for a package that only has IR
 * lookback (no classic dom.json).
 */
export function packageHasInspectableDom(input: {
  dom?: DomArtifact | null;
  instantReplay?: InstantReplayArtifact | null;
}): boolean {
  return resolveDomArtifactForPlayer(input) !== null;
}

export type ReportUploadHistoryInput = {
  recordingUrl: string;
  pageUrl?: string;
  indexFileId?: string | null;
  targetFolderId?: string | null;
  durationMs?: number;
  provider: StorageProviderId;
  uploadedAt?: number;
};

/**
 * History entry for screenshot / Instant Replay uploads (no recording session).
 */
export function buildReportUploadHistoryEntry(input: ReportUploadHistoryInput): UploadHistoryEntry {
  const uploadedAt =
    typeof input.uploadedAt === "number" && Number.isFinite(input.uploadedAt)
      ? input.uploadedAt
      : Date.now();
  const recordingUrl = input.recordingUrl;
  const indexKey = input.indexFileId || recordingUrl;
  return {
    id: `${indexKey}:${uploadedAt}`,
    uploadedAt,
    pageUrl: input.pageUrl || "",
    recordingUrl,
    recordingFolderId: null,
    targetFolderId: input.targetFolderId ?? null,
    durationMs:
      typeof input.durationMs === "number" && Number.isFinite(input.durationMs)
        ? Math.max(0, input.durationMs)
        : 0,
    provider: input.provider,
  };
}
