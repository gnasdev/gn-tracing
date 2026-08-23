/**
 * Firefox full-record path: in-page evidence + extension-page display video.
 *
 * Does not construct CdpManager.
 *
 * Preferred video path is getDisplayMedia (often prearmed from the popup Start
 * gesture). When not prearmed, the media host auto-opens the OS share picker.
 * Tab-frame snapshots are last resort. Evidence attach still runs before media
 * start so activeTab remains valid if the media host steals focus for share.
 * Network metadata is owned solely by webRequest; in-page posts of kind
 * "network" are ignored so a request is never written twice.
 */

import type { StorageManager } from "../../background/storage-manager";
import {
  describeCaptureSurfaceLimitation,
  describeSurfaceTitleMismatch,
} from "../../media-pipeline/capture-surface";
import type { ConsoleEntry, StorageSnapshot, WebSocketEntry } from "../../types/recording";
import { CollectorSet } from "../evidence/collector-set";
import { InPageEvidenceCollector } from "../evidence/in-page-collector";
import { WebRequestNetworkCollector } from "../evidence/web-request/collector";
import { ExtensionPageMediaHost } from "../media/page-host";
import type {
  EvidenceEntry,
  RecordingFinalizeInput,
  RecordingFinalizeResult,
  RecordingRuntime,
  RecordingStartInput,
} from "./types";

export class FirefoxRecordingRuntime implements RecordingRuntime {
  readonly mediaKind = "extension-page" as const;
  readonly #storage: StorageManager;
  readonly #media = new ExtensionPageMediaHost();
  readonly #evidence: CollectorSet;
  #sessionId: string | null = null;
  /** Limitations from the most recent attach; merged into finalize's result. */
  #attachLimitations: string[] = [];

  constructor(storage: StorageManager) {
    this.#storage = storage;
    this.#evidence = new CollectorSet([
      new InPageEvidenceCollector(),
      new WebRequestNetworkCollector(storage),
    ]);
  }

  get activeSessionId(): string | null {
    return this.#media.activeSessionId;
  }

  async start(input: RecordingStartInput): Promise<{ firstFrameAt: number | null }> {
    this.#storage.setCaptureSettings(input.settings);
    this.#storage.setPrivacySettings(input.privacySettings, input.onRedactionHits);

    this.#sessionId = input.sessionId;

    // Prepare while the tab still holds activeTab. A legacy getDisplayMedia
    // fallback focuses the media host and revokes activeTab, so attach first.
    const attached = await this.#evidence.attach({
      tabId: input.tabId,
      sessionId: input.sessionId,
    });
    this.#attachLimitations = [
      ...attached.limitations,
      ...describeMissingCapabilityLimitations(attached.capabilities),
    ];
    // Best-effort: ok when at least one collector prepared. Fail only when
    // nothing is available (see CollectorSet.attach).
    if (!attached.ok) {
      throw new Error(attached.limitations[0] ?? "Evidence capture could not attach.");
    }

    // Display capture (preferred / prearmed) or tab-frame last resort.
    const firstFrameAt = await this.#media.startCapture(input.tabId, input.sessionId, {
      prearmed: Boolean(input.mediaPrearmed),
      firstFrameAt: input.firstFrameAt,
      capturedSurface: input.capturedSurface,
      microphoneEnabled: input.settings.microphoneEnabled,
      microphoneDeviceId: input.settings.microphoneDeviceId,
    });

    // Arm webRequest tab scope + in-page START once video is live.
    const armed = await this.#evidence.beginSession({
      tabId: input.tabId,
      sessionId: input.sessionId,
    });
    this.#attachLimitations.push(...armed.limitations);

    // Tab-frame path is snapshot-based (not continuous compositor capture).
    if ((this.#media.capturedSurface?.displaySurface || "").toLowerCase() === "browser") {
      this.#attachLimitations.push(
        "Video is captured as periodic snapshots of the recorded tab " +
          "(not continuous screen share), so fast motion may look stepped.",
      );
    }

    const surfaceMismatch = describeSurfaceTitleMismatch(
      this.#media.capturedSurface,
      await this.#readTabTitle(input.tabId),
    );
    if (surfaceMismatch) {
      this.#attachLimitations.push(surfaceMismatch);
    }

    // Tab-frame path does not steal focus; legacy share picker still needs restore.
    if (!input.mediaPrearmed) {
      await this.#media.restoreRecordedTabFocus(input.tabId);
    }

    this.#media.hydrateActiveSession(input.sessionId);
    return { firstFrameAt: firstFrameAt ?? null };
  }

  async #readTabTitle(tabId: number): Promise<string> {
    try {
      const tab = await chrome.tabs.get(tabId);
      return typeof tab.title === "string" ? tab.title : "";
    } catch {
      return "";
    }
  }

  /**
   * Re-arm evidence capture after the recorded tab navigated.
   *
   * A navigation destroys the injected scripts, and nothing used to put them back —
   * only user-event capture and the drawing overlay were re-armed. That is why a
   * recording on a dev server that reloads ended with an empty console.json and
   * "Receiving end does not exist" at stop.
   */
  async reinjectEvidenceCapture(tabId: number, sessionId: string): Promise<void> {
    if (this.#sessionId && sessionId !== this.#sessionId) {
      return;
    }
    await this.#evidence.reattach(tabId, sessionId);
  }

  stopMedia(discard = false): Promise<void> {
    return this.#media.stopCapture(discard);
  }

  async finalizeEvidence(_input: RecordingFinalizeInput): Promise<RecordingFinalizeResult> {
    const { limitations: detachLimitations } = await this.#evidence.detach();
    this.#sessionId = null;
    const limitations: string[] = [...this.#attachLimitations, ...detachLimitations];

    // Firefox cannot capture a single tab, so the video always shows more than the
    // recorded page. Say which surface was shared instead of letting the viewer
    // assume a tab-scoped recording.
    const surfaceLimitation = describeCaptureSurfaceLimitation(this.#media.capturedSurface);
    if (surfaceLimitation) {
      limitations.push(surfaceLimitation);
    }

    return {
      evidenceCoverage: this.#evidence.evidenceCoverage,
      sourceMapDiagnostics: null,
      privacyLimitations: limitations,
    };
  }

  async discard(): Promise<void> {
    await Promise.allSettled([this.#media.stopCapture(true), this.#evidence.detach()]);
    this.#sessionId = null;
    await this.#media.cleanup();
  }

  onRecordingComplete(sessionId?: string): void {
    this.#media.onRecordingComplete(sessionId);
  }

  clearActiveSession(): void {
    this.#media.clearActiveSession();
  }

  hydrateActiveSession(sessionId: string | null): void {
    this.#media.hydrateActiveSession(sessionId);
  }

  ensurePackagingContext(): Promise<void> {
    return this.#media.ensurePackagingContext();
  }

  async closeMediaHostIfIdle(): Promise<void> {
    // Keep the capture popup window; tearing it down mid-upload is harmful.
  }

  releaseSourceMaps(): void {
    // No CDP source maps on Firefox.
  }

  ingestEvidenceEntry(sessionId: string, kind: string, entry: EvidenceEntry): void {
    if (this.#sessionId && sessionId !== this.#sessionId) {
      return;
    }
    if (kind === "console") {
      this.#storage.addConsoleEntry(entry as ConsoleEntry);
      return;
    }
    // Single network owner: WebRequestNetworkCollector. In-page START disables
    // fetch/XHR patches on full-record; this branch is defense-in-depth so a
    // stale MAIN script or Instant Replay residual cannot double-write.
    if (kind === "network") {
      return;
    }
    if (kind === "websocket") {
      this.#storage.upsertWebSocketEntry(entry as WebSocketEntry);
      return;
    }
    if (kind === "storage") {
      this.#storage.setStorageSnapshot(entry as StorageSnapshot);
    }
  }

  async captureDomSnapshotMarker(_label: string): Promise<void> {
    // No CDP DOM snapshots on Firefox full record.
  }
}

/**
 * Attach may succeed with only one of console/network. Surface that at start so
 * a half-armed session is not mistaken for full evidence.
 */
function describeMissingCapabilityLimitations(capabilities: readonly string[]): string[] {
  const have = new Set(capabilities);
  const notes: string[] = [];
  if (!have.has("console")) {
    notes.push(
      "Console evidence is unavailable for this recording. Grant site access " +
        "(or allow page instrumentation) if you need console and WebSocket rows.",
    );
  }
  if (!have.has("network")) {
    notes.push(
      "Network evidence is unavailable for this recording. The webRequest " +
        "permission may be missing or the network collector failed to prepare.",
    );
  }
  return notes;
}
