/**
 * Adapter: MAIN/ISOLATED-world content-script capture behind the
 * `EvidenceCollector` seam.
 *
 * Owns console, uncaught errors, and WebSocket frames only. Network evidence
 * moved to `WebRequestNetworkCollector`, which sees the whole tab across all
 * frames including requests the browser issues itself — coverage this
 * mechanism cannot reach because it only observes calls the page's own
 * JavaScript makes. `CollectorSet`'s no-overlap guard enforces this split at
 * construction: both collectors claiming "network" would throw immediately.
 *
 * Wraps the exact injection sequence `FirefoxRecordingRuntime` used before this
 * seam existed: inject ISOLATED bridge, inject MAIN patcher (both `allFrames`),
 * verify the MAIN script landed in the page realm (not a sandbox or a
 * CSP-blocked injection), then send START. Reordering or dropping a step here
 * reintroduces bugs measured earlier this session (silent wrong-realm capture,
 * iframes invisible to injection) — see the comments on each step for the
 * evidence.
 */

import type { RecordingCapability } from "../../../packages/replay-core/src/schema/package";
import { injectScriptFile } from "../../shared/inject-script";
import type {
  EvidenceAttachInput,
  EvidenceAttachResult,
  EvidenceCollector,
  EvidenceDetachResult,
} from "./types";

const MAIN_SCRIPT = "content/in-page-capture-main.js";
const BRIDGE_SCRIPT = "content/in-page-capture-bridge.js";

/**
 * What in-page capture delivers when it lands. No "network": webRequest now
 * owns network evidence on Firefox (fuller coverage — all frames, browser-
 * issued requests included). No "network-bodies" either: in-page network
 * entries always write `responseBody: null` (same rationale as
 * `FIREFOX_EXTENSION_CAPABILITIES` in `packages/replay-core/src/schema/package.ts`).
 */
const IN_PAGE_CAPABILITIES: readonly RecordingCapability[] = ["console", "websocket"];

export class InPageEvidenceCollector implements EvidenceCollector {
  readonly id = "in-page";
  readonly provides = IN_PAGE_CAPABILITIES;
  #tabId: number | null = null;
  /** Remembered from the last attach() so reattach() after a navigation can
   * restart capture with the same response-body policy, not silently fall
   * back to "off". */
  #responseBodyMode: EvidenceAttachInput["responseBodyMode"];
  #maxResponseBodyBytes: EvidenceAttachInput["maxResponseBodyBytes"];

  async attach(input: EvidenceAttachInput): Promise<EvidenceAttachResult> {
    this.#tabId = input.tabId;
    this.#responseBodyMode = input.responseBodyMode;
    this.#maxResponseBodyBytes = input.maxResponseBodyBytes;
    const outcome = await this.#injectAndVerify(input.tabId);
    if (!outcome.ok) {
      return { ok: false, capabilities: [], limitations: [outcome.error] };
    }

    await chrome.tabs.sendMessage(input.tabId, {
      target: "in-page-capture",
      type: "START",
      sessionId: input.sessionId,
      responseBodyMode: input.responseBodyMode,
      maxResponseBodyBytes: input.maxResponseBodyBytes,
    });

    const limitations = [
      ...frameFailureLimitation(outcome.partialFailures),
      ...responseBodyLimitation(input.responseBodyMode),
    ];
    const capabilities: RecordingCapability[] = [...IN_PAGE_CAPABILITIES];
    if ((input.responseBodyMode ?? "off") !== "off") {
      // Reported optimistically: the actual eligibility gate (MIME, size,
      // XHR responseType) runs per-request inside the capture patch, so some
      // requests will still have no body even with a mode configured. That
      // matches how the CDP path already reports "network-bodies" — the
      // capability means "can capture bodies", not "captured every body".
      capabilities.push("network-bodies");
    }
    return { ok: true, capabilities, limitations };
  }

  async detach(): Promise<EvidenceDetachResult> {
    const tabId = this.#tabId;
    this.#tabId = null;
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
   * Only user-event capture and the drawing overlay used to be re-armed here;
   * in-page evidence was not, which is why a recording on a reloading dev
   * server ended with an empty console.json.
   */
  async reattach(tabId: number, sessionId: string): Promise<void> {
    const outcome = await this.#injectAndVerify(tabId);
    if (!outcome.ok) {
      console.warn(`[GN Tracing] ${outcome.error}`);
      return;
    }
    try {
      await chrome.tabs.sendMessage(tabId, {
        target: "in-page-capture",
        type: "START",
        sessionId,
        responseBodyMode: this.#responseBodyMode,
        maxResponseBodyBytes: this.#maxResponseBodyBytes,
      });
      console.info("[GN Tracing] Re-armed in-page capture after navigation.");
    } catch (error) {
      console.warn("[GN Tracing] Could not restart in-page capture after navigation:", error);
    }
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
    // iframe's console and network traffic is missing — a gap Chromium does not
    // have because CDP attaches to the whole tab.
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
      "In-page console/network capture could not be installed in the recorded tab " +
      `(${detail}). Grant GN Tracing access to this site to capture console and ` +
      "network evidence."
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

function responseBodyLimitation(mode: string | undefined): string[] {
  if ((mode ?? "off") === "off") {
    return [];
  }
  return [
    "Response bodies are captured only for fetch/XHR calls the page itself makes " +
      "with a readable text response; requests the browser issues directly, and " +
      "XHR reads using responseType other than text, have no body.",
  ];
}
