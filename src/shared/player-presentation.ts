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
 * Pure resolver — no DOM. The player applies the returned plan to chrome.
 */
export function resolvePresentationMode(evidence: PresentationEvidence): PresentationPlan {
  const hasScreenshots = evidence.screenshotCount > 0;
  const hasLogs = hasLogEvidence(evidence);

  if (evidence.hasVideo) {
    return {
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
    };
  }

  if (hasScreenshots) {
    const hasConsoleData = evidence.consoleCount > 0;
    const hasNetworkData = evidence.networkCount > 0 || evidence.websocketCount > 0;
    return {
      mode: "screenshot",
      defaultTab: "screenshots",
      showVideoSection: false,
      showLayoutSplitter: false,
      // Only surface log tabs when the package actually carried them (forward-compat
      // if screenshot reports later attach console/network).
      showConsoleTab: hasConsoleData,
      showNetworkTab: hasNetworkData,
      showScreenshotsTab: true,
      showReportTab: evidence.hasReportContent,
      showActivityTab: evidence.activityCount > 0,
      showStorageTab: evidence.hasStorage,
      showElementsTab: evidence.hasDom,
      noVideoNotice: "screenshot",
    };
  }

  if (hasLogs) {
    return {
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
    };
  }

  return {
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
  };
}
