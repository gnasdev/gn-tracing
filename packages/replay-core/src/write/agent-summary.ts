/**
 * Builds the `agent-summary.json` artifact at packaging time.
 *
 * Why a package carries one at all: an agent (or the player's "Copy for AI"
 * export) needs a small, ranked view of the recording, and computing one means
 * parsing `console.json` + `network.json`, which can be tens of megabytes.
 * Doing it once while packaging turns that into a single ~10 KB read.
 *
 * Lives in the writer rather than in the extension because every producer owes
 * readers this artifact, and because `buildAgentSummary` is the same function
 * the MCP server runs for packages recorded before the artifact existed — one
 * implementation, so a stored summary and a computed one cannot disagree.
 */

import type { PackageMetadata } from "../schema/package";
import { buildAgentSummary } from "../summarize";
import { encodeJsonArtifact } from "./package-writer";

/**
 * Above this total artifact size the summary is skipped rather than re-parsing
 * during an upload the user is waiting on. Readers recompute it on demand, so
 * skipping costs nothing but bandwidth.
 */
export const MAX_AGENT_SUMMARY_INPUT_BYTES = 32 * 1024 * 1024;

export interface AgentSummaryArtifactInput {
  metadata: PackageMetadata;
  console?: Uint8Array | null;
  network?: Uint8Array | null;
  websocket?: Uint8Array | null;
  events?: Uint8Array | null;
  privacy?: Uint8Array | null;
  report?: Uint8Array | null;
  /** Artifact ids already staged for the package. */
  availableArtifacts: string[];
  /** Package timestamp, so the artifact is deterministic for a given upload. */
  generatedAt: string;
}

/** The same input after the caller has parsed each artifact. */
export interface ParsedAgentSummaryInput {
  metadata: PackageMetadata;
  /**
   * Total size of the console/network/websocket/events artifacts. The caller
   * supplies it so the size guard can run *before* anything is read: the whole
   * point of the ceiling is to avoid touching tens of megabytes during an
   * upload the user is waiting on.
   */
  sourceBytes: number;
  console?: unknown;
  network?: unknown;
  websocket?: unknown;
  events?: unknown;
  privacy?: unknown;
  report?: unknown;
  availableArtifacts: string[];
  generatedAt: string;
}

/**
 * Returns the encoded summary, or null when it should be skipped.
 *
 * Best effort by design: a summary failure must never fail an upload, because
 * every reader can recompute it.
 */
export function buildAgentSummaryArtifact(input: AgentSummaryArtifactInput): Uint8Array | null {
  return buildAgentSummaryArtifactFromParsed({
    metadata: input.metadata,
    sourceBytes: [input.console, input.network, input.websocket, input.events].reduce(
      (total, bytes) => total + (bytes?.byteLength ?? 0),
      0,
    ),
    console: parseJsonBytes(input.console),
    network: parseJsonBytes(input.network),
    websocket: parseJsonBytes(input.websocket),
    events: parseJsonBytes(input.events),
    privacy: parseJsonBytes(input.privacy),
    report: parseJsonBytes(input.report),
    availableArtifacts: input.availableArtifacts,
    generatedAt: input.generatedAt,
  });
}

/**
 * For producers that already hold parsed artifacts — the extension reads them
 * as `Blob`s and would otherwise pay an encode/decode round trip to hand this
 * module bytes it is only going to parse again.
 */
export function buildAgentSummaryArtifactFromParsed(
  input: ParsedAgentSummaryInput,
): Uint8Array | null {
  if (input.sourceBytes > MAX_AGENT_SUMMARY_INPUT_BYTES) {
    return null;
  }

  try {
    const summary = buildAgentSummary({
      metadata: input.metadata,
      console: input.console,
      network: input.network,
      websocket: input.websocket,
      events: input.events,
      privacy: input.privacy,
      report: input.report,
      availableArtifacts: input.availableArtifacts,
      generatedAt: input.generatedAt,
    });
    return encodeJsonArtifact(summary);
  } catch {
    return null;
  }
}

function parseJsonBytes(bytes: Uint8Array | null | undefined): unknown {
  if (!bytes) {
    return undefined;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}
