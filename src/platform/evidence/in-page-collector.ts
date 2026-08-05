/**
 * Adapter: MAIN/ISOLATED-world content-script capture behind the
 * `EvidenceCollector` seam.
 *
 * Owns console, uncaught errors, and WebSocket frames only. Network evidence
 * on Firefox full-record is owned by `WebRequestNetworkCollector`, which sees
 * the whole tab across all frames including browser-issued requests. In-page
 * START therefore disables fetch/XHR patches (`captureNetwork: false`) so
 * page-script network rows are never produced on this path. `CollectorSet`'s
 * no-overlap guard also enforces the capability split at construction.
 *
 * Lifecycle is two-phase:
 * - `attach` injects both worlds and verifies the MAIN realm (while activeTab
 *   is still valid). It does **not** START capture.
 * - `beginSession` sends START after the caller has committed the session
 *   (share picker accepted). That avoids recording the picker detour and
 *   leaves the page uninstrumented if the user cancels.
 *
 * Response bodies are intentionally not claimed or armed here: webRequest has
 * no body sink yet, and optimistic `network-bodies` would lie to readers.
 */

import type { RecordingCapability } from "../../../packages/replay-core/src/schema/package";
import { injectScriptFile } from "../../shared/inject-script";
import type {
  EvidenceAttachInput,
  EvidenceAttachResult,
  EvidenceBeginSessionInput,
  EvidenceCollector,
  EvidenceDetachResult,
} from "./types";

const MAIN_SCRIPT = "content/in-page-capture-main.js";
const BRIDGE_SCRIPT = "content/in-page-capture-bridge.js";

/**
 * What in-page capture delivers on Firefox full-record when inject lands.
 * No "network" / "network-bodies": webRequest owns network metadata; bodies
 * are a later phase. Console + websocket only.
 */
const IN_PAGE_CAPABILITIES: readonly RecordingCapability[] = ["console", "websocket"];

export class InPageEvidenceCollector implements EvidenceCollector {
  readonly id = "in-page";
  readonly provides = IN_PAGE_CAPABILITIES;
  #tabId: number | null = null;
  #sessionId: string | null = null;
  /** True after attach prepared successfully; beginSession is a no-op otherwise. */
  #prepared = false;

  async attach(input: EvidenceAttachInput): Promise<EvidenceAttachResult> {
    this.#tabId = input.tabId;
    this.#sessionId = input.sessionId;
    this.#prepared = false;
    const outcome = await this.#injectAndVerify(input.tabId);
    if (!outcome.ok) {
      return { ok: false, capabilities: [], limitations: [outcome.error] };
    }

    this.#prepared = true;
    const limitations = frameFailureLimitation(outcome.partialFailures);
    return {
      ok: true,
      capabilities: [...IN_PAGE_CAPABILITIES],
      limitations,
    };
  }

  async beginSession(input: EvidenceBeginSessionInput): Promise<{ limitations: string[] }> {
    this.#tabId = input.tabId;
    this.#sessionId = input.sessionId;

    // Attach may have prepared scripts that died during the long share-picker arm
    // window (navigation, discard, content-script GC). Prefer a fast START when
    // the bridge still answers; on failure re-inject + START like reattach so a
    // committed media session is not discarded solely for a dead bridge.
    if (this.#prepared) {
      try {
        await this.#sendStart(input.tabId, input.sessionId);
        return { limitations: [] };
      } catch {
        // Fall through to re-inject.
      }
    }

    const outcome = await this.#injectAndVerify(input.tabId);
    if (!outcome.ok) {
      this.#prepared = false;
      return { limitations: [outcome.error] };
    }
    this.#prepared = true;
    try {
      await this.#sendStart(input.tabId, input.sessionId);
      return { limitations: frameFailureLimitation(outcome.partialFailures) };
    } catch (error) {
      this.#prepared = false;
      return {
        limitations: [
          "In-page console capture could not start after screen sharing was accepted " +
            `(${(error as Error)?.message || String(error)}). Video still records; ` +
            "console and WebSocket evidence may be missing.",
        ],
      };
    }
  }

  async detach(): Promise<EvidenceDetachResult> {
    const tabId = this.#tabId;
    this.#tabId = null;
    this.#sessionId = null;
    this.#prepared = false;
    if (tabId == null) {
      return { limitations: [] };
    }

    // Bridge only resolves after MAIN cleanup + entry deliveries drain.
    const response = (await chrome.tabs
      .sendMessage(tabId, { target: "in-page-capture", type: "STOP" })
      .catch((error: Error) => ({ ok: false, error: error?.message || "In-page stop failed" }))) as
      | { ok?: boolean; error?: string }
      | undefined;

    if (response && response.ok === false) {
      // Timed-out drain still continues finalize; best-effort packaging.
      console.warn("[GN Tracing] In-page capture stop drain:", response.error);
    }
    return { limitations: [] };
  }

  /**
   * Re-arm after navigation destroyed the injected content scripts.
   *
   * Inject + START together: the session is already committed, so there is no
   * share-picker phase to wait for.
   */
  async reattach(tabId: number, sessionId: string): Promise<void> {
    this.#tabId = tabId;
    this.#sessionId = sessionId;
    const outcome = await this.#injectAndVerify(tabId);
    if (!outcome.ok) {
      this.#prepared = false;
      console.warn(`[GN Tracing] ${outcome.error}`);
      return;
    }
    this.#prepared = true;
    try {
      await this.#sendStart(tabId, sessionId);
      console.info("[GN Tracing] Re-armed in-page capture after navigation.");
    } catch (error) {
      console.warn("[GN Tracing] Could not restart in-page capture after navigation:", error);
    }
  }

  /**
   * START without network patches and without body mode: full-record network
   * is owned by webRequest, and Firefox has no body sink yet.
   */
  async #sendStart(tabId: number, sessionId: string): Promise<void> {
    await chrome.tabs.sendMessage(tabId, {
      target: "in-page-capture",
      type: "START",
      sessionId,
      // Sole network owner on full-record is webRequest; do not emit page-script
      // network rows that would either duplicate metadata or need to be dropped.
      captureNetwork: false,
    });
  }

  /**
   * Inject both worlds and confirm the MAIN patcher landed in the page realm.
   *
   * `world: "MAIN"` needs Firefox 128+ and is subject to the page's CSP, unlike
   * Chrome. Either failure mode resolves without an `InjectionResult.error`, so
   * a resolved promise alone is not proof the capture is live — the realm check
   * is what actually proves it.
   */
  async #injectAndVerify(
    tabId: number,
  ): Promise<{ ok: true; partialFailures: string[] } | { ok: false; error: string }> {
    const bridge = await injectScriptFile({
      tabId,
      file: BRIDGE_SCRIPT,
      world: "ISOLATED",
      allFrames: true,
    });
    if (!bridge.ok) {
      return { ok: false, error: this.#describeFailure(`bridge: ${bridge.error}`) };
    }

    // allFrames: without it only the top document is instrumented, so every
    // iframe's console traffic is missing — a gap Chromium does not have
    // because CDP attaches to the whole tab.
    const main = await injectScriptFile({
      tabId,
      file: MAIN_SCRIPT,
      world: "MAIN",
      allFrames: true,
    });
    if (!main.ok) {
      return { ok: false, error: this.#describeFailure(`main world: ${main.error}`) };
    }

    const realm = await this.#verifyPageRealm(tabId);
    if (!realm.ok) {
      return { ok: false, error: this.#describeFailure(`main world: ${realm.error}`) };
    }

    return {
      ok: true,
      partialFailures: [...(bridge.partialFailures ?? []), ...(main.partialFailures ?? [])],
    };
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

  #describeFailure(detail: string): string {
    return (
      "In-page console capture could not be installed in the recorded tab " +
      `(${detail}). Grant GN Tracing access to this site to capture console and ` +
      "WebSocket evidence."
    );
  }
}

function frameFailureLimitation(partialFailures: string[]): string[] {
  if (partialFailures.length === 0) {
    return [];
  }
  return [
    `Console evidence is missing for ${partialFailures.length} ` +
      "frame(s) that refused instrumentation (typically cross-origin or sandboxed iframes).",
  ];
}
