/**
 * The player's single bridge to typed shared code.
 *
 * `public/player.js` is plain, unbundled JavaScript loaded with a `<script>`
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
  hydrateDomNodeToHtml,
  type PackageMetadata,
  type RecordingCapability,
  renderBugReportMarkdown,
  resolveCapabilities,
} from "../packages/replay-core/src/index";
import { coerceEpochMs } from "../packages/replay-core/src/time";
import {
  MAX_EOCD_SEARCH_SPAN,
  parseZipCentralDirectory,
  type ZipEntryRecord,
  type ZipParseResult,
} from "../packages/replay-core/src/zip-reader";
import { buildAgentReportMarkdown, buildAgentSummaryForPlayer } from "../src/shared/agent-report";
import {
  mapInstantReplayToDomArtifact,
  packageHasInspectableDom,
  resolveDomArtifactForPlayer,
} from "../src/shared/instant-replay-policy";
import {
  detectNetworkFilterFromUrlAndMime,
  getNetworkFilterType,
  type NetworkFilterBucket,
  type NetworkFilterInput,
} from "../src/shared/network-filter-type";
import {
  type NetworkResponseBodyDisplay,
  type NetworkResponseBodyDisplayKind,
  resolveNetworkResponseBodyDisplay,
} from "../src/shared/network-response-body";
import {
  eventRelativeTimesMs,
  findActiveEventIndexByRelativeMs,
  getActiveSnapshotIndexByTime,
  indexAtOrBefore,
} from "../src/shared/player-clock-index";
import {
  formatMessage,
  DEFAULT_LANGUAGE as I18N_DEFAULT_LANGUAGE,
  TRANSLATIONS as I18N_TRANSLATIONS,
  isUiLanguage,
  type UiLanguage,
} from "../src/shared/player-i18n";
import {
  aggregateLoadingProgress,
  mergeLoadingEntry,
  normalizeLoadingStatus,
} from "../src/shared/player-loading-progress";
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
import {
  clampStillZoom,
  createStillViewerTransform,
  panStillViewer,
  resetStillViewerTransform,
  rotateStillCw,
  STILL_ZOOM_MAX,
  STILL_ZOOM_MIN,
  STILL_ZOOM_STEP,
  type StillRotationDeg,
  type StillViewerTransform,
  stillFigureAspectFromViewport,
  stillViewerCssTransform,
  stillZoomPercentLabel,
  zoomInStill,
  zoomOutStill,
} from "../src/shared/still-viewer-transform";
import { diffStorageGroups, toStorageItems } from "../src/shared/storage-diff";

export type {
  NetworkFilterBucket,
  NetworkFilterInput,
  NetworkResponseBodyDisplay,
  NetworkResponseBodyDisplayKind,
  PackageMetadata,
  PresentationEvidence,
  PresentationMode,
  PresentationPlan,
  RecordingCapability,
  StillRotationDeg,
  StillViewerTransform,
  UiLanguage,
  ZipEntryRecord,
  ZipParseResult,
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

/** Storage tab start↔stop key diff (pure). */
export const storageDiff = { diffStorageGroups, toStorageItems };

/** Active index at playhead for activity / storage snapshots. */
export const clockIndex = {
  indexAtOrBefore,
  eventRelativeTimesMs,
  getActiveSnapshotIndexByTime,
  findActiveEventIndexByRelativeMs,
};

/** Loading bar aggregation (pure). */
export const loadingProgress = {
  aggregateLoadingProgress,
  mergeLoadingEntry,
  normalizeLoadingStatus,
};

/** EN/VI catalog — single production source. */
export const i18n = {
  TRANSLATIONS: I18N_TRANSLATIONS,
  DEFAULT_LANGUAGE: I18N_DEFAULT_LANGUAGE,
  formatMessage,
  isUiLanguage,
};

/** Structural ZIP central-directory parse (shared with package readers). */
export const zip = {
  parseZipCentralDirectory,
  MAX_EOCD_SEARCH_SPAN,
};

/** Zoom / rotate / pan math for the no-video still media stage. */
export const stillViewer = {
  STILL_ZOOM_MIN,
  STILL_ZOOM_MAX,
  STILL_ZOOM_STEP,
  clampStillZoom,
  createStillViewerTransform,
  zoomInStill,
  zoomOutStill,
  rotateStillCw,
  resetStillViewerTransform,
  panStillViewer,
  stillViewerCssTransform,
  stillZoomPercentLabel,
  stillFigureAspectFromViewport,
};

/** Instant Replay lookback → Elements DOM snapshots (and related helpers). */
export const instantReplay = {
  mapInstantReplayToDomArtifact,
  packageHasInspectableDom,
  resolveDomArtifactForPlayer,
};

/** Structural DOM preview for Instant Replay / Elements scrubber. */
export const dom = {
  hydrateDomNodeToHtml,
};

/** Network list filter buckets + response-body empty-state helpers. */
export const network = {
  getNetworkFilterType,
  detectNetworkFilterFromUrlAndMime,
  resolveNetworkResponseBodyDisplay,
};

/**
 * What the producer claims it could capture. The player uses this to tell a
 * recording that has no video because the SDK cannot capture any from one whose
 * video failed to load — the two need very different UI.
 */
export const capabilities = { hasCapability, resolveCapabilities };

/** Timestamp helpers shared between extension and player. */
export const time = { coerceEpochMs };

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
