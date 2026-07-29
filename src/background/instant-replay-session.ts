/**
 * Instant Replay helpers for the always-on DOM buffer product path.
 *
 * Instant Replay is not a Start/Stop recording session. The content script
 * keeps a rolling DOM lookback (plus optional console/network/storage evidence);
 * the service worker collects (non-destructively) and commits only after a
 * successful upload.
 */

import type { InstantReplayEvidenceBundle } from "../../packages/replay-core/src/capture/instant-replay-evidence";
import type { InstantReplayArtifact } from "../../packages/replay-core/src/schema/annotation";
import {
  mergeEvidenceBundles,
  normalizeEvidenceBundle,
  parseMainWorldEvidenceJson,
} from "../shared/instant-replay-evidence-bridge";
import { hasInstantReplayFrames } from "../shared/instant-replay-policy";

export {
  evidenceBundleHasData,
  evidenceBundleHasLogData,
  mergeEvidenceBundles,
  parseMainWorldEvidenceJson,
} from "../shared/instant-replay-evidence-bridge";
export {
  COLLECT_INSTANT_REPLAY_ACTION,
  COMMIT_INSTANT_REPLAY_ACTION,
  hasInstantReplayFrames,
} from "../shared/instant-replay-policy";

/** Built MAIN-world companion script path (esbuild out). */
export const INSTANT_REPLAY_EVIDENCE_CONTENT_SCRIPT = "content/instant-replay-evidence.js";

export type CollectInstantReplayResult =
  | {
      ok: true;
      artifact: InstantReplayArtifact;
      evidence: InstantReplayEvidenceBundle | null;
      disabledReason: string | null;
    }
  | { ok: false; error: string; disabledReason?: string | null };

/**
 * Normalize a collect response from the content script.
 * Evidence is best-effort: missing/timeout does not fail the collect when DOM frames exist.
 */
export function parseCollectInstantReplayResponse(response: unknown): CollectInstantReplayResult {
  if (!response || typeof response !== "object") {
    return {
      ok: false,
      error:
        "Instant Replay is not running on this tab. Enable Instant Replay and reload the page if needed.",
    };
  }

  const body = response as {
    ok?: boolean;
    artifact?: InstantReplayArtifact | null;
    evidence?: unknown;
    disabledReason?: string | null;
  };

  const disabledReason = typeof body.disabledReason === "string" ? body.disabledReason : null;

  if (body.ok === false) {
    return {
      ok: false,
      error: disabledReason || "Instant Replay could not be collected.",
      disabledReason,
    };
  }

  if (!hasInstantReplayFrames(body.artifact ?? null)) {
    return {
      ok: false,
      error: disabledReason
        ? disabledReason
        : "No Instant Replay lookback yet on this tab. Browse a bit after enabling Instant Replay, then try again.",
      disabledReason,
    };
  }

  return {
    ok: true,
    artifact: body.artifact as InstantReplayArtifact,
    evidence: normalizeEvidenceBundle(body.evidence),
    disabledReason,
  };
}

/**
 * Merge MAIN-world executeScript evidence into a successful DOM collect.
 * Always merges (does not short-circuit on storage-only bridge payloads) so
 * console/network rings from MAIN win when the postMessage path dropped them.
 */
export function withMainWorldEvidenceFallback(
  collected: CollectInstantReplayResult,
  mainWorldEvidenceJson: unknown,
): CollectInstantReplayResult {
  if (!collected.ok) {
    return collected;
  }
  const fromMain = parseMainWorldEvidenceJson(mainWorldEvidenceJson);
  return {
    ...collected,
    evidence: mergeEvidenceBundles(collected.evidence, fromMain),
  };
}
