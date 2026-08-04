/**
 * Instant Replay CDP hub (MVP): one focused allowlisted tab owns chrome.debugger.
 *
 * When Instant Replay is enabled and the active tab's host is on the allowlist,
 * we attach CDP (debugger banner) and keep rolling console/network rings in a
 * dedicated StorageManager. Record hand-off detaches IR first so the recording
 * path can attach cleanly.
 */

import type { InstantReplayEvidenceBundle } from "../../packages/replay-core/src/capture/instant-replay-evidence";
import { tabUrlMatchesInstantReplayAllowlist } from "../shared/instant-replay-domain";
import { CdpManager } from "./cdp-manager";
import { pickPrivacyRedactionSettings, type UploadSettingsStore } from "./settings-store";
import { StorageManager } from "./storage-manager";

export type InstantReplayCdpStatus = {
  attachedTabId: number | null;
  pausedForRecording: boolean;
  lastError: string | null;
};

type HubDeps = {
  getSettings: () => Promise<UploadSettingsStore>;
  getTab: (tabId: number) => Promise<chrome.tabs.Tab>;
  queryActiveTab: () => Promise<chrome.tabs.Tab | undefined>;
};

/**
 * Surface used by the service worker so call sites stay unconditional.
 * Non-CDP browsers get {@link NullInstantReplayCdpHub}.
 */
export interface InstantReplayCdpHubLike {
  sync(): Promise<void>;
  pauseForRecording(recordingTabId: number | null): Promise<void>;
  resumeAfterRecording(): Promise<void>;
  peekEvidenceBundle(): InstantReplayEvidenceBundle | null;
  clearBuffersAfterCommit(): void;
  isAttachedTo(tabId: number): boolean;
  getStatus(): InstantReplayCdpStatus;
}

/**
 * Testable hub. Production wires real chrome.tabs via createInstantReplayCdpHub.
 */
export class InstantReplayCdpHub implements InstantReplayCdpHubLike {
  readonly storage = new StorageManager();
  readonly cdp = new CdpManager(this.storage);

  #attachedTabId: number | null = null;
  #pausedForRecording = false;
  #lastError: string | null = null;
  #syncing = false;
  readonly #deps: HubDeps;

  constructor(deps: HubDeps) {
    this.#deps = deps;
  }

  getStatus(): InstantReplayCdpStatus {
    return {
      attachedTabId: this.#attachedTabId,
      pausedForRecording: this.#pausedForRecording,
      lastError: this.#lastError,
    };
  }

  /**
   * Align attach state with settings + active tab. Safe to call often
   * (activation, navigation, settings save, boot).
   */
  async sync(): Promise<void> {
    if (this.#syncing) {
      return;
    }
    this.#syncing = true;
    try {
      if (this.#pausedForRecording) {
        return;
      }
      const settings = await this.#deps.getSettings();
      if (!settings.instantReplayEnabled) {
        await this.#detachInternal("disabled");
        return;
      }
      const allowlist = settings.instantReplayAllowedDomains ?? [];
      if (allowlist.length === 0) {
        await this.#detachInternal("empty-allowlist");
        this.#lastError =
          "Add at least one allowed domain so Instant Replay can attach the debugger.";
        return;
      }

      const active = await this.#deps.queryActiveTab();
      const tabId = typeof active?.id === "number" ? active.id : null;
      const url = active?.url;
      if (tabId == null || !tabUrlMatchesInstantReplayAllowlist(url, allowlist)) {
        await this.#detachInternal("no-match");
        return;
      }

      const windowMs = Math.max(1_000, (settings.instantReplayWindowSeconds || 120) * 1000);

      if (this.#attachedTabId === tabId) {
        this.storage.setRollingWindowMs(windowMs);
        this.storage.trimToRollingWindow();
        this.#applyCaptureSettings(settings);
        this.#lastError = null;
        return;
      }

      await this.#detachInternal("switch-tab");
      await this.#attachToTab(tabId, settings, windowMs);
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error);
      try {
        await this.#detachInternal("error");
      } catch {
        // ignore
      }
    } finally {
      this.#syncing = false;
    }
  }

  /**
   * Record is about to take the debugger on this tab (or any tab).
   * Detach IR CDP and freeze rings until resumeAfterRecording.
   */
  async pauseForRecording(recordingTabId: number | null): Promise<void> {
    this.#pausedForRecording = true;
    if (
      this.#attachedTabId != null &&
      (recordingTabId == null || this.#attachedTabId === recordingTabId)
    ) {
      await this.#detachInternal("recording");
    } else if (this.#attachedTabId != null) {
      // Recording a different tab — still release so only one owner is clear.
      await this.#detachInternal("recording-other-tab");
    }
  }

  /** After Record stops, allow IR to re-attach if settings still match. */
  async resumeAfterRecording(): Promise<void> {
    this.#pausedForRecording = false;
    await this.sync();
  }

  /**
   * Non-destructive snapshot of CDP rings for package build.
   * Returns null when nothing is attached / no log rows.
   */
  peekEvidenceBundle(): InstantReplayEvidenceBundle | null {
    const artifacts = this.storage.peekFinalizedArtifacts();
    const consoleEntries = artifacts.consoleLogs
      ? (JSON.parse(artifacts.consoleLogs) as InstantReplayEvidenceBundle["console"])
      : [];
    const network = artifacts.networkRequests
      ? ((
          JSON.parse(artifacts.networkRequests) as {
            entries?: InstantReplayEvidenceBundle["network"];
          }
        ).entries ?? [])
      : [];
    const websocket = artifacts.webSocketLogs
      ? (JSON.parse(artifacts.webSocketLogs) as InstantReplayEvidenceBundle["websocket"])
      : [];
    const storage = artifacts.storageSnapshots
      ? ((
          JSON.parse(artifacts.storageSnapshots) as {
            snapshots?: InstantReplayEvidenceBundle["storage"];
          }
        ).snapshots ?? [])
      : [];

    const bundle: InstantReplayEvidenceBundle = {
      console: Array.isArray(consoleEntries) ? consoleEntries : [],
      network: Array.isArray(network) ? network : [],
      websocket: Array.isArray(websocket) ? websocket : [],
      storage: Array.isArray(storage) ? storage : [],
    };
    if (
      bundle.console.length === 0 &&
      bundle.network.length === 0 &&
      bundle.websocket.length === 0 &&
      bundle.storage.length === 0
    ) {
      return null;
    }
    return bundle;
  }

  /** Clear rings after successful IR package upload (keep debugger attached). */
  clearBuffersAfterCommit(): void {
    this.storage.beginSession();
    // Re-apply rolling window after clear.
    void this.#deps.getSettings().then((settings) => {
      const windowMs = Math.max(1_000, (settings.instantReplayWindowSeconds || 120) * 1000);
      this.storage.setRollingWindowMs(windowMs);
      this.#applyCaptureSettings(settings);
    });
  }

  isAttachedTo(tabId: number): boolean {
    return this.#attachedTabId === tabId && !this.#pausedForRecording;
  }

  async #attachToTab(
    tabId: number,
    settings: UploadSettingsStore,
    windowMs: number,
  ): Promise<void> {
    this.storage.beginSession();
    this.storage.setRollingWindowMs(windowMs);
    this.#applyCaptureSettings(settings);
    await this.cdp.attach(tabId);
    this.#attachedTabId = tabId;
    this.#lastError = null;
    // Optional start storage snapshot (best-effort; same as Record).
    if (settings.captureStorage) {
      try {
        await this.cdp.captureStorageSnapshot("start");
      } catch {
        // ignore
      }
    }
  }

  async #detachInternal(_reason: string): Promise<void> {
    if (this.#attachedTabId == null) {
      return;
    }
    try {
      await this.cdp.detach();
    } catch {
      // already detached
    }
    try {
      this.cdp.releaseSourceMaps();
    } catch {
      // ignore
    }
    this.#attachedTabId = null;
  }

  #applyCaptureSettings(settings: UploadSettingsStore): void {
    const privacy = pickPrivacyRedactionSettings(settings);
    this.storage.setCaptureSettings(settings);
    this.storage.setPrivacySettings(privacy);
    this.cdp.setCaptureSettings(settings);
    this.cdp.setPrivacySettings(privacy);
  }
}

/** No-op hub for Firefox (and any build without chrome.debugger). */
export class NullInstantReplayCdpHub implements InstantReplayCdpHubLike {
  async sync(): Promise<void> {}
  async pauseForRecording(_recordingTabId: number | null): Promise<void> {}
  async resumeAfterRecording(): Promise<void> {}
  peekEvidenceBundle(): InstantReplayEvidenceBundle | null {
    return null;
  }
  clearBuffersAfterCommit(): void {}
  isAttachedTo(_tabId: number): boolean {
    return false;
  }
  getStatus(): InstantReplayCdpStatus {
    return { attachedTabId: null, pausedForRecording: false, lastError: null };
  }
}

export function createInstantReplayCdpHub(
  getSettings: () => Promise<UploadSettingsStore>,
): InstantReplayCdpHub {
  return new InstantReplayCdpHub({
    getSettings,
    getTab: (tabId) => chrome.tabs.get(tabId),
    queryActiveTab: async () => {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      return tab;
    },
  });
}

/**
 * Build-time selection: Chromium gets a live hub; Firefox gets a no-op.
 */
export function createInstantReplayCdpHubForBrowser(
  getSettings: () => Promise<UploadSettingsStore>,
  hasCdp: boolean,
): InstantReplayCdpHubLike {
  if (!hasCdp) {
    return new NullInstantReplayCdpHub();
  }
  return createInstantReplayCdpHub(getSettings);
}
