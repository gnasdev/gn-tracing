import { describe, expect, it } from "vitest";
import { type PresentationEvidence, resolvePresentationMode } from "./player-presentation";

const empty: PresentationEvidence = {
  hasVideo: false,
  screenshotCount: 0,
  consoleCount: 0,
  networkCount: 0,
  websocketCount: 0,
  activityCount: 0,
  hasStorage: false,
  hasDom: false,
  hasReportContent: false,
};

describe("resolvePresentationMode", () => {
  it("keeps the full-recording shell when video is present", () => {
    const plan = resolvePresentationMode({
      ...empty,
      hasVideo: true,
      consoleCount: 0,
      hasReportContent: true,
    });
    expect(plan.mode).toBe("recording");
    expect(plan.showVideoSection).toBe(true);
    expect(plan.showLayoutSplitter).toBe(true);
    expect(plan.showConsoleTab).toBe(true);
    expect(plan.showNetworkTab).toBe(true);
    expect(plan.defaultTab).toBe("report");
    expect(plan.noVideoNotice).toBe("none");
  });

  it("uses screenshot mode for annotated stills without video", () => {
    const plan = resolvePresentationMode({
      ...empty,
      screenshotCount: 1,
    });
    expect(plan.mode).toBe("screenshot");
    expect(plan.defaultTab).toBe("screenshots");
    expect(plan.showVideoSection).toBe(false);
    expect(plan.showLayoutSplitter).toBe(false);
    expect(plan.showConsoleTab).toBe(false);
    expect(plan.showNetworkTab).toBe(false);
    expect(plan.showScreenshotsTab).toBe(true);
    expect(plan.noVideoNotice).toBe("screenshot");
  });

  it("surfaces console/network on screenshot packages only when data exists", () => {
    const plan = resolvePresentationMode({
      ...empty,
      screenshotCount: 2,
      consoleCount: 3,
      networkCount: 1,
    });
    expect(plan.mode).toBe("screenshot");
    expect(plan.showConsoleTab).toBe(true);
    expect(plan.showNetworkTab).toBe(true);
    expect(plan.defaultTab).toBe("screenshots");
  });

  it("uses sdk-logs mode when there is no video but log evidence exists", () => {
    const plan = resolvePresentationMode({
      ...empty,
      consoleCount: 5,
      networkCount: 2,
    });
    expect(plan.mode).toBe("sdk-logs");
    expect(plan.showVideoSection).toBe(true);
    expect(plan.noVideoNotice).toBe("sdk");
    expect(plan.defaultTab).toBe("console");
    expect(plan.showConsoleTab).toBe(true);
    expect(plan.showNetworkTab).toBe(true);
  });

  it("prefers screenshots over sdk-logs when both stills and logs exist without video", () => {
    const plan = resolvePresentationMode({
      ...empty,
      screenshotCount: 1,
      consoleCount: 4,
    });
    expect(plan.mode).toBe("screenshot");
    expect(plan.defaultTab).toBe("screenshots");
    expect(plan.showConsoleTab).toBe(true);
  });

  it("falls back to empty-evidence when nothing usable is present", () => {
    const plan = resolvePresentationMode(empty);
    expect(plan.mode).toBe("empty-evidence");
    expect(plan.showVideoSection).toBe(false);
    expect(plan.showScreenshotsTab).toBe(false);
  });

  it("shows screenshots tab on full recordings that also carry annotated shots", () => {
    const plan = resolvePresentationMode({
      ...empty,
      hasVideo: true,
      screenshotCount: 1,
    });
    expect(plan.mode).toBe("recording");
    expect(plan.showScreenshotsTab).toBe(true);
  });

  it("opens Elements for Instant Replay lookback when hasDom is set without stills", () => {
    const plan = resolvePresentationMode({
      ...empty,
      hasDom: true,
    });
    expect(plan.mode).toBe("screenshot");
    expect(plan.defaultTab).toBe("elements");
    expect(plan.showElementsTab).toBe(true);
    expect(plan.showScreenshotsTab).toBe(false);
    // Media column hosts the DOM scrubber stage.
    expect(plan.showVideoSection).toBe(true);
    expect(plan.showDomStage).toBe(true);
  });

  it("always offers Console/Network tabs for Instant Replay packages", () => {
    const quiet = resolvePresentationMode({
      ...empty,
      hasDom: true,
      hasInstantReplay: true,
      consoleCount: 0,
      networkCount: 0,
    });
    expect(quiet.mode).toBe("screenshot");
    expect(quiet.showConsoleTab).toBe(true);
    expect(quiet.showNetworkTab).toBe(true);
    expect(quiet.defaultTab).toBe("elements");

    const withLogs = resolvePresentationMode({
      ...empty,
      hasDom: true,
      hasInstantReplay: true,
      consoleCount: 2,
    });
    expect(withLogs.showConsoleTab).toBe(true);
    expect(withLogs.defaultTab).toBe("console");
  });

  it("keeps video primary and hides DOM stage when video is present", () => {
    const plan = resolvePresentationMode({
      ...empty,
      hasVideo: true,
      hasDom: true,
    });
    expect(plan.showDomStage).toBe(false);
    expect(plan.showVideoSection).toBe(true);
  });

  it("keeps stills primary and hides DOM stage when screenshots exist", () => {
    const plan = resolvePresentationMode({
      ...empty,
      screenshotCount: 1,
      hasDom: true,
    });
    expect(plan.showDomStage).toBe(false);
    expect(plan.showScreenshotsTab).toBe(true);
    expect(plan.defaultTab).toBe("screenshots");
  });
});
