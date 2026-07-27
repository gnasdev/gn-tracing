/**
 * The player's single bridge to typed shared code.
 *
 * `player/player.js` is plain, unbundled JavaScript loaded with a `<script>`
 * tag, so it cannot `import`. It used to reach typed modules through one
 * hand-written vendoring script per module, each producing its own IIFE and its
 * own global — a pattern that charged a new build script for every piece of
 * shared code the player wanted.
 *
 * This entry replaces that with one bundle (`window.gnCore`). Adding a shared
 * module to the player is now an export here, not a new script under
 * `scripts/`.
 *
 * Third-party bundles stay separate: `vendor/luna/*` ships prebuilt, and
 * `vendor/webm-seek-fix/` wraps an npm dependency together with its licence.
 */

import {
  describeAnnotation,
  renderAnnotationsSvg,
  renderScreenshotMarkdown,
  renderScreenshotOverlaySvg,
} from "../packages/replay-core/src/annotate";
import {
  buildAgentSummary,
  hasCapability,
  type PackageMetadata,
  type RecordingCapability,
  renderBugReportMarkdown,
  resolveCapabilities,
} from "../packages/replay-core/src/index";
import { buildAgentReportMarkdown, buildAgentSummaryForPlayer } from "../src/shared/agent-report";
import {
  type PresentationEvidence,
  type PresentationMode,
  type PresentationPlan,
  resolvePresentationMode,
} from "../src/shared/player-presentation";
import {
  getFiniteDurationMs,
  ratioToTimeMs,
  reconcileSeekClock,
  resolveTimelineDurationMs,
  SEEK_COMMIT_TOLERANCE_MS,
} from "../src/shared/player-timeline-seek";

export type {
  PackageMetadata,
  PresentationEvidence,
  PresentationMode,
  PresentationPlan,
  RecordingCapability,
};

/** "Copy for AI" — the player's Markdown export of a recording. */
export const agentReport = { buildAgentReportMarkdown, buildAgentSummaryForPlayer };

/** Single seek/duration source shared with the extension surfaces. */
export const timelineSeek = {
  SEEK_COMMIT_TOLERANCE_MS,
  getFiniteDurationMs,
  ratioToTimeMs,
  reconcileSeekClock,
  resolveTimelineDurationMs,
};

/** Which shell to show for recording vs screenshot vs SDK packages. */
export const presentation = { resolvePresentationMode };

/**
 * What the producer claims it could capture. The player uses this to tell a
 * recording that has no video because the SDK cannot capture any from one whose
 * video failed to load — the two need very different UI.
 */
export const capabilities = { hasCapability, resolveCapabilities };

/** Summary and report builders, exposed for the "Copy for AI" path. */
export const summary = { buildAgentSummary, renderBugReportMarkdown };

/**
 * Screenshot annotations. The player draws overlays with the same renderer the
 * extension's editor previews with, which is the only way an arrow lands where
 * the reporter put it.
 */
export const annotate = {
  describeAnnotation,
  renderAnnotationsSvg,
  renderScreenshotMarkdown,
  renderScreenshotOverlaySvg,
};
