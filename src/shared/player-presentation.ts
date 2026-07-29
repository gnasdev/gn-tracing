/**
 * Which shell the replay player should show for a loaded package.
 *
 * Full recordings, screenshot reports, and SDK sessions share one player
 * runtime. Branching on raw "is there video?" is not enough: a screenshot
 * report and an SDK package both lack video, but one wants stills as the
 * primary surface and the other wants console/network.
 */

export type PresentationMode = "recording" | "screenshot" | "sdk-logs" | "empty-evidence";

export interface PresentationEvidence {
  /** True when the package has playable video parts. */
  hasVideo: boolean;
  /** Annotated screenshot entries present in screenshots.json. */
  screenshotCount: number;
  /** Console log entries loaded into the player. */
  consoleCount: number;
  /** Network request entries. */
  networkCount: number;
  /** WebSocket connection entries. */
  websocketCount: number;
  /** User-event timeline rows. */
  activityCount: number;
  /** Storage artifact present with at least one snapshot group. */
  hasStorage: boolean;
  /** DOM snapshot artifact present with at least one snapshot. */
  hasDom: boolean;
  /** Report / privacy / legacy stop-time screenshot content for the Report tab. */
  hasReportContent: boolean;
  /**
   * Instant Replay lookback frames in the package. When true, the player always
   * offers Console/Network tabs (IR claims in-page log capture even if a quiet
   * window left those artifacts empty).
   */
  hasInstantReplay?: boolean;
}

export interface PresentationPlan {
  mode: PresentationMode;
  /** Default logs tab to activate after load. */
  defaultTab:
    | "report"
    | "activity"
    | "console"
    | "network"
    | "storage"
    | "elements"
    | "screenshots";
  showVideoSection: boolean;
  /**
   * Show the structural DOM lookback stage (iframe scrubber) in the media column.
   * True for no-video packages that have DOM/IR frames and no annotated stills.
   */
  showDomStage: boolean;
  /**
   * Show the annotated still viewport in the media column (zoom/rotate chrome).
   * Mutually exclusive with video and DOM stage as the primary surface.
   */
  showStillStage: boolean;
  showLayoutSplitter: boolean;
  showConsoleTab: boolean;
  showNetworkTab: boolean;
  showScreenshotsTab: boolean;
  showReportTab: boolean;
  showActivityTab: boolean;
  showStorageTab: boolean;
  showElementsTab: boolean;
  /**
   * Which no-video copy to show when the video section is visible without media.
   * Still-primary and recording shells use "none"; sdk-logs uses the SDK notice.
   */
  noVideoNotice: "none" | "sdk" | "screenshot";
}

function withMediaStages(
  plan: Omit<PresentationPlan, "showDomStage" | "showStillStage">,
  evidence: PresentationEvidence,
): PresentationPlan {
  // Only one primary surface: video wins; else stills; else DOM lookback.
  const showStillStage = !evidence.hasVideo && evidence.screenshotCount > 0;
  const showDomStage =
    !evidence.hasVideo && !showStillStage && evidence.hasDom && evidence.screenshotCount === 0;
  return { ...plan, showDomStage, showStillStage };
}

function hasLogEvidence(evidence: PresentationEvidence): boolean {
  return (
    evidence.consoleCount > 0 ||
    evidence.networkCount > 0 ||
    evidence.websocketCount > 0 ||
    evidence.activityCount > 0 ||
    evidence.hasStorage ||
    evidence.hasDom
  );
}

/**
 * When Instant Replay frames were mapped into hasDom (Elements), prefer
 * Elements as the primary surface if there are no annotated stills.
 */
function defaultTabForDomLookback(evidence: PresentationEvidence): PresentationPlan["defaultTab"] {
  if (evidence.hasDom && evidence.screenshotCount === 0) {
    return "elements";
  }
  // Still-primary packages show the image in the media column; Report holds
  // caption/annotations (not a second Screenshots tab with the same image).
  if (evidence.screenshotCount > 0) {
    return "report";
  }
  return "console";
}

/**
 * Pure resolver — no DOM. The player applies the returned plan to chrome.
 */
export function resolvePresentationMode(evidence: PresentationEvidence): PresentationPlan {
  const hasScreenshots = evidence.screenshotCount > 0;
  const hasLogs = hasLogEvidence(evidence);

  if (evidence.hasVideo) {
    return withMediaStages(
      {
        mode: "recording",
        defaultTab: evidence.hasReportContent
          ? "report"
          : evidence.activityCount > 0
            ? "activity"
            : "console",
        showVideoSection: true,
        showLayoutSplitter: true,
        // DevTools-like: keep console/network visible even when the session was quiet.
        showConsoleTab: true,
        showNetworkTab: true,
        showScreenshotsTab: hasScreenshots,
        showReportTab: evidence.hasReportContent,
        showActivityTab: evidence.activityCount > 0,
        showStorageTab: evidence.hasStorage,
        showElementsTab: evidence.hasDom,
        noVideoNotice: "none",
      },
      evidence,
    );
  }

  // Annotated stills and/or Instant Replay lookback mapped into hasDom.
  if (hasScreenshots || (evidence.hasDom && !evidence.hasVideo)) {
    const irLookback = Boolean(evidence.hasInstantReplay);
    // IR packages always expose Console/Network (empty state is fine). Plain
    // screenshot reports still hide empty log tabs.
    const hasConsoleData = evidence.consoleCount > 0 || irLookback;
    const hasNetworkData = evidence.networkCount > 0 || evidence.websocketCount > 0 || irLookback;
    // Prefer Console when IR lookback actually captured log rows.
    const defaultTab =
      irLookback && evidence.consoleCount > 0 ? "console" : defaultTabForDomLookback(evidence);
    // Still-primary packages use the record-like media column (still stage).
    // DOM-only lookback also keeps the media column for the scrubber.
    const mediaColumn = hasScreenshots || evidence.hasDom;
    // When still is primary, the Screenshots tab would only re-show the same
    // image — hide it and surface Report for caption/annotations instead.
    const stillPrimary = hasScreenshots && !evidence.hasVideo;
    return withMediaStages(
      {
        mode: "screenshot",
        defaultTab,
        showVideoSection: mediaColumn,
        showLayoutSplitter: mediaColumn,
        showConsoleTab: hasConsoleData,
        showNetworkTab: hasNetworkData,
        showScreenshotsTab: hasScreenshots && !stillPrimary,
        showReportTab: evidence.hasReportContent || stillPrimary,
        showActivityTab: evidence.activityCount > 0,
        showStorageTab: evidence.hasStorage,
        showElementsTab: evidence.hasDom,
        noVideoNotice: "none",
      },
      evidence,
    );
  }

  if (hasLogs) {
    return withMediaStages(
      {
        mode: "sdk-logs",
        defaultTab:
          evidence.consoleCount > 0
            ? "console"
            : evidence.networkCount > 0 || evidence.websocketCount > 0
              ? "network"
              : evidence.hasStorage
                ? "storage"
                : evidence.hasDom
                  ? "elements"
                  : evidence.activityCount > 0
                    ? "activity"
                    : "console",
        showVideoSection: true,
        showLayoutSplitter: true,
        showConsoleTab: true,
        showNetworkTab: true,
        showScreenshotsTab: false,
        showReportTab: evidence.hasReportContent,
        showActivityTab: evidence.activityCount > 0,
        showStorageTab: evidence.hasStorage,
        showElementsTab: evidence.hasDom,
        noVideoNotice: "sdk",
      },
      evidence,
    );
  }

  return withMediaStages(
    {
      mode: "empty-evidence",
      defaultTab: evidence.hasReportContent ? "report" : "console",
      showVideoSection: false,
      showLayoutSplitter: false,
      showConsoleTab: true,
      showNetworkTab: false,
      showScreenshotsTab: false,
      showReportTab: evidence.hasReportContent,
      showActivityTab: false,
      showStorageTab: false,
      showElementsTab: false,
      noVideoNotice: "none",
    },
    evidence,
  );
}
