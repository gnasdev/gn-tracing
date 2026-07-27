/**
 * Blob-shaped adapter over the core's `agent-summary.json` builder.
 *
 * The summary logic lives in `packages/replay-core/src/write/agent-summary.ts`
 * so the browser SDK emits the identical artifact. This file exists only to
 * bridge the offscreen document's `Blob` world to the core's `Uint8Array` one.
 */

import type { PackageMetadata } from "../../packages/replay-core/src/schema/package";
import {
  buildAgentSummaryArtifactFromParsed,
  MAX_AGENT_SUMMARY_INPUT_BYTES,
} from "../../packages/replay-core/src/write/agent-summary";

export { MAX_AGENT_SUMMARY_INPUT_BYTES };

export interface AgentSummaryBlobInput {
  metadata: PackageMetadata;
  consoleBlob: Blob | null;
  networkBlob: Blob | null;
  websocketBlob: Blob | null;
  eventsBlob: Blob | null;
  privacyBlob: Blob | null;
  reportBlob: Blob | null;
  /** Artifact ids already staged for the package. */
  availableArtifacts: string[];
  /** Package timestamp, so the artifact is deterministic for a given upload. */
  generatedAt: string;
}

/**
 * Returns the summary blob, or null when it should be skipped.
 *
 * Best effort by design: a summary failure must never fail an upload, because
 * every reader can recompute it.
 */
export async function createAgentSummaryBlob(input: AgentSummaryBlobInput): Promise<Blob | null> {
  // Sized before reading: the ceiling exists to avoid parsing tens of megabytes
  // during an upload the user is waiting on, so touching the blobs first would
  // defeat it.
  const sourceBytes = [
    input.consoleBlob,
    input.networkBlob,
    input.websocketBlob,
    input.eventsBlob,
  ].reduce((total, blob) => total + (blob?.size ?? 0), 0);

  if (sourceBytes > MAX_AGENT_SUMMARY_INPUT_BYTES) {
    return null;
  }

  const [consoleArtifact, networkArtifact, websocketArtifact, events, privacy, report] =
    await Promise.all([
      parseArtifactBlob(input.consoleBlob),
      parseArtifactBlob(input.networkBlob),
      parseArtifactBlob(input.websocketBlob),
      parseArtifactBlob(input.eventsBlob),
      parseArtifactBlob(input.privacyBlob),
      parseArtifactBlob(input.reportBlob),
    ]);

  const summary = buildAgentSummaryArtifactFromParsed({
    metadata: input.metadata,
    sourceBytes,
    console: consoleArtifact,
    network: networkArtifact,
    websocket: websocketArtifact,
    events,
    privacy,
    report,
    availableArtifacts: input.availableArtifacts,
    generatedAt: input.generatedAt,
  });

  return summary ? new Blob([summary as BlobPart], { type: "application/json" }) : null;
}

/** One unreadable artifact must not cost the others their place in the summary. */
async function parseArtifactBlob(blob: Blob | null): Promise<unknown> {
  if (!blob) {
    return undefined;
  }
  try {
    return JSON.parse(await blob.text());
  } catch {
    return undefined;
  }
}
