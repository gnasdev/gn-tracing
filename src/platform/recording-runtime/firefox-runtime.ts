/**
 * Firefox full-record path: in-page evidence + extension-page getDisplayMedia.
 *
 * Does not construct CdpManager.
 */

import type { StorageManager } from "../../background/storage-manager";
import { describeCaptureSurfaceLimitation } from "../../media-pipeline/capture-surface";
import { injectScriptFile } from "../../shared/inject-script";
import type {
  ConsoleEntry,
  NetworkEntry,
  StorageSnapshot,
  WebSocketEntry,
} from "../../types/recording";
import { ExtensionPageMediaHost } from "../media/page-host";
import type {
  EvidenceEntry,
  RecordingFinalizeInput,
  RecordingFinalizeResult,
  RecordingRuntime,
  RecordingStartInput,
} from "./types";

const MAIN_SCRIPT = "content/in-page-capture-main.js";
const BRIDGE_SCRIPT = "content/in-page-capture-bridge.js";

export class FirefoxRecordingRuntime implements RecordingRuntime {
  readonly mediaKind = "extension-page" as const;
  readonly #storage: StorageManager;
  readonly #media = new ExtensionPageMediaHost();
  #tabId: number | null = null;
  #sessionId: string | null = null;
  /** Frames that refused injection; reported as an evidence-completeness limit. */
  #frameInjectionFailures: string[] = [];

  constructor(storage: StorageManager) {
    this.#storage = storage;
  }

  get activeSessionId(): string | null {
    return this.#media.activeSessionId;
  }

  async start(input: RecordingStartInput): Promise<{ firstFrameAt: number | null }> {
    this.#storage.setCaptureSettings(input.settings);
    this.#storage.setPrivacySettings(input.privacySettings, input.onRedactionHits);

    this.#tabId = input.tabId;
    this.#sessionId = input.sessionId;

    // Inject while the tab still holds activeTab: startCapture below focuses the
    // media host tab, which revokes it. A resolved executeScript is not proof the
    // script ran on Firefox, so the outcome is inspected rather than discarded.
    await this.#injectInPageCapture(input.tabId, { throwOnFailure: true });

    // Media first: it blocks on the user clicking "Choose what to share" (and on
    // the browser's share picker), and it is the step that can be cancelled.
    // Starting in-page evidence before that would capture the picker detour, and a
    // cancel would leave the page instrumented.
    const firstFrameAt = await this.#media.startCapture(input.tabId, input.sessionId);

    await chrome.tabs.sendMessage(input.tabId, {
      target: "in-page-capture",
      type: "START",
      sessionId: input.sessionId,
    });

    this.#media.hydrateActiveSession(input.sessionId);
    return { firstFrameAt: firstFrameAt ?? null };
  }

  /**
   * Inject the ISOLATED bridge and the MAIN-world patcher.
   *
   * `world: "MAIN"` needs Firefox 128+ (Mozilla: "In Firefox 128, support is now
   * available for the MAIN execution world for … scripting.executeScript"), which
   * `strict_min_version` does not guarantee — so a failure here is reported rather
   * than assumed impossible.
   */
  async #injectInPageCapture(
    tabId: number,
    options: { throwOnFailure: boolean },
  ): Promise<boolean> {
    const bridge = await injectScriptFile({
      tabId,
      file: BRIDGE_SCRIPT,
      world: "ISOLATED",
      allFrames: true,
    });
    if (!bridge.ok) {
      return this.#reportInjectionFailure(`bridge: ${bridge.error}`, options);
    }

    // allFrames: without it only the top document is instrumented, so every
    // iframe's console and network traffic is missing — a gap Chromium does not
    // have because CDP attaches to the whole tab. Frames that refuse (cross-origin
    // or sandboxed) are recorded as a limitation instead of failing the recording.
    const main = await injectScriptFile({
      tabId,
      file: MAIN_SCRIPT,
      world: "MAIN",
      allFrames: true,
    });
    if (!main.ok) {
      return this.#reportInjectionFailure(`main world: ${main.error}`, options);
    }

    this.#frameInjectionFailures = [
      ...(bridge.partialFailures ?? []),
      ...(main.partialFailures ?? []),
    ];

    // "It ran" is not "it ran in the page". A MAIN-world injection that landed in
    // the isolated sandbox patches the sandbox's console/fetch and captures
    // nothing, with no error to inspect — so ask the bridge to confirm the page
    // realm before reporting success.
    const realm = await this.#verifyPageRealm(tabId);
    if (!realm.ok) {
      return this.#reportInjectionFailure(`main world: ${realm.error}`, options);
    }
    return true;
  }

  /** Ask the ISOLATED bridge whether the MAIN sentinel is visible on the page. */
  async #verifyPageRealm(tabId: number): Promise<{ ok: boolean; error?: string }> {
    try {
      const response = (await chrome.tabs.sendMessage(tabId, {
        target: "in-page-capture",
        type: "VERIFY_REALM",
      })) as { ok?: boolean; error?: string } | undefined;

      if (!response) {
        return { ok: false, error: "the in-page capture bridge did not answer the realm check" };
      }
      return response.ok
        ? { ok: true }
        : { ok: false, error: response.error ?? "realm check failed" };
    } catch (error) {
      return { ok: false, error: (error as Error)?.message || String(error) };
    }
  }

  #reportInjectionFailure(detail: string, options: { throwOnFailure: boolean }): boolean {
    const message =
      "In-page console/network capture could not be installed in the recorded tab " +
      `(${detail}). Grant GN Tracing access to this site to capture console and ` +
      "network evidence.";
    if (options.throwOnFailure) {
      throw new Error(message);
    }
    console.warn(`[GN Tracing] ${message}`);
    return false;
  }

  /**
   * Re-arm in-page capture after the recorded tab navigated.
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
    if (!(await this.#injectInPageCapture(tabId, { throwOnFailure: false }))) {
      return;
    }
    try {
      await chrome.tabs.sendMessage(tabId, {
        target: "in-page-capture",
        type: "START",
        sessionId,
      });
      console.info("[GN Tracing] Re-armed in-page capture after navigation.");
    } catch (error) {
      console.warn("[GN Tracing] Could not restart in-page capture after navigation:", error);
    }
  }

  stopMedia(discard = false): Promise<void> {
    return this.#media.stopCapture(discard);
  }

  async finalizeEvidence(_input: RecordingFinalizeInput): Promise<RecordingFinalizeResult> {
    await this.#stopInPage();
    const limitations: string[] = [];

    // Firefox cannot capture a single tab, so the video always shows more than the
    // recorded page. Say which surface was shared instead of letting the viewer
    // assume a tab-scoped recording.
    const surfaceLimitation = describeCaptureSurfaceLimitation(this.#media.capturedSurface);
    if (surfaceLimitation) {
      limitations.push(surfaceLimitation);
    }

    // An iframe that refused injection contributes no console or network rows at
    // all. Whoever reads the replay has to know the evidence is incomplete rather
    // than concluding the frame was silent.
    if (this.#frameInjectionFailures.length > 0) {
      limitations.push(
        `Console and network evidence is missing for ${this.#frameInjectionFailures.length} ` +
          "frame(s) that refused instrumentation (typically cross-origin or sandboxed iframes).",
      );
    }

    // Page instrumentation only sees requests the page's own JavaScript makes.
    // Requests the browser issues itself — the document, images, stylesheets,
    // scripts, fonts, iframes — are invisible to it, unlike Chromium's CDP path.
    limitations.push(
      "Network evidence covers fetch, XHR and WebSocket traffic from page scripts. " +
        "Requests issued by the browser itself (the document, images, stylesheets, " +
        "scripts, fonts) are not included on this browser.",
    );

    return { sourceMapDiagnostics: null, privacyLimitations: limitations };
  }

  async discard(): Promise<void> {
    await Promise.allSettled([this.#media.stopCapture(true), this.#stopInPage()]);
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
    // Keep the extension media tab; tearing it down mid-upload is harmful.
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
    if (kind === "network") {
      this.#storage.addNetworkEntry(entry as NetworkEntry);
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

  async #stopInPage(): Promise<void> {
    const tabId = this.#tabId;
    if (tabId != null) {
      // Bridge only resolves after MAIN cleanup + entry deliveries drain.
      const response = (await chrome.tabs
        .sendMessage(tabId, {
          target: "in-page-capture",
          type: "STOP",
        })
        .catch((error: Error) => ({
          ok: false,
          error: error?.message || "In-page stop failed",
        }))) as { ok?: boolean; error?: string } | undefined;

      if (response && response.ok === false) {
        // Timed-out drain still continues finalize; best-effort packaging.
        console.warn("[GN Tracing] In-page capture stop drain:", response.error);
      }
    }
    this.#tabId = null;
    this.#sessionId = null;
  }
}
