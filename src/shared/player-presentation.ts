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
   * Screenshot mode hides the section entirely, so this is mainly for sdk-logs.
   */
  noVideoNotice: "none" | "sdk" | "screenshot";
}

function withDomStage(
  plan: Omit<PresentationPlan, "showDomStage">,
  evidence: PresentationEvidence,
): PresentationPlan {
  // Video owns the media column. Annotated stills stay primary when present.
  const showDomStage = !evidence.hasVideo && evidence.hasDom && evidence.screenshotCount === 0;
  return { ...plan, showDomStage };
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
  if (evidence.screenshotCount > 0) {
    return "screenshots";
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
    return withDomStage(
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
    // When DOM stage is primary (no stills), keep the media column visible for the scrubber.
    const domStagePrimary = evidence.hasDom && evidence.screenshotCount === 0;
    // Prefer Console when IR lookback actually captured log rows.
    const defaultTab =
      irLookback && evidence.consoleCount > 0 ? "console" : defaultTabForDomLookback(evidence);
    return withDomStage(
      {
        mode: "screenshot",
        defaultTab,
        showVideoSection: domStagePrimary,
        showLayoutSplitter: domStagePrimary,
        showConsoleTab: hasConsoleData,
        showNetworkTab: hasNetworkData,
        showScreenshotsTab: hasScreenshots,
        showReportTab: evidence.hasReportContent,
        showActivityTab: evidence.activityCount > 0,
        showStorageTab: evidence.hasStorage,
        showElementsTab: evidence.hasDom,
        noVideoNotice: domStagePrimary ? "none" : "screenshot",
      },
      evidence,
    );
  }

  if (hasLogs) {
    return withDomStage(
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

  return withDomStage(
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
