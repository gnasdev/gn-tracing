/**
 * "Copy for AI" — the player's Markdown export of a recording.
 *
 * The player already holds every artifact in memory once a replay is open, so it
 * can produce the same report the MCP server does without any download. That
 * matters for the non-technical path: a QA tester who cannot install an MCP
 * server can still hand an agent a complete, correctly framed summary.
 *
 * Reaches `player-standalone/public/player.js` through the single core bundle built by
 * `scripts/build-player-core-vendor.mjs` (`window.gnCore.agentReport`).
 * `player.js` is plain, unbundled JavaScript, so a global is the only way it
 * can reach typed shared code.
 */

import {
  type AgentSummary,
  buildAgentSummary,
  type PackageMetadata,
  renderBugReportMarkdown,
} from "../../packages/replay-core/src/index";

export interface AgentReportInput {
  metadata: PackageMetadata;
  /** Entries as the player holds them; a `relativeMs` already on an entry wins. */
  console?: unknown;
  network?: unknown;
  websocket?: unknown;
  events?: unknown;
  privacy?: unknown;
  report?: unknown;
  availableArtifacts?: string[];
  /** Replay link to cite in the report, when the player knows it. */
  replayUrl?: string;
  /** Centres the report on the current playhead. */
  focusMs?: number;
  windowMs?: number;
  /** Injected so the caller controls the timestamp (and tests stay stable). */
  generatedAt?: string;
}

export function buildAgentSummaryForPlayer(input: AgentReportInput): AgentSummary {
  return buildAgentSummary({
    metadata: input.metadata,
    console: input.console,
    network: input.network,
    websocket: input.websocket,
    events: input.events,
    privacy: input.privacy,
    report: input.report,
    availableArtifacts: input.availableArtifacts,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  });
}

/** Renders the Markdown report the player copies to the clipboard. */
export function buildAgentReportMarkdown(input: AgentReportInput): string {
  return renderBugReportMarkdown(buildAgentSummaryForPlayer(input), {
    replayUrl: input.replayUrl,
    focusMs: input.focusMs,
    windowMs: input.windowMs,
  });
}
