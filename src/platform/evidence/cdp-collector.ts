/**
 * Adapter: `CdpManager` behind the `EvidenceCollector` seam.
 *
 * Wraps the existing manager rather than rewriting it — `CdpManager` owns 2000+
 * lines of correct, load-bearing CDP protocol handling (network correlation,
 * source-map resolution, storage/DOM snapshot timing) that a rewrite could
 * subtly break in ways no test catches until a real recording is inspected.
 * This class only re-shapes its existing lifecycle calls into the collector
 * contract; `attach`/`detach` here are the exact calls
 * `ChromiumRecordingRuntime` made directly before this seam existed.
 *
 * CDP begins observing as soon as the debugger attaches, so `beginSession` is
 * a no-op (there is no separate START step like in-page capture).
 */

import type { RecordingCapability } from "../../../packages/replay-core/src/schema/package";
import type { CdpManager } from "../../background/cdp-manager";
import type { EvidenceOffer } from "./surfaces";
import type {
  EvidenceAttachInput,
  EvidenceAttachResult,
  EvidenceBeginSessionInput,
  EvidenceBeginSessionResult,
  EvidenceCollector,
  EvidenceDetachResult,
} from "./types";

/** Everything CDP delivers when attach succeeds. Chromium has no partial mode. */
const CDP_CAPABILITIES: readonly RecordingCapability[] = [
  "console",
  "network",
  "network-bodies",
  "websocket",
  "storage",
  "cookies",
  "dom-snapshot",
  "source-maps",
  "cross-origin",
];

const CDP_EVIDENCE_OFFERS: readonly EvidenceOffer[] = [
  { source: "cdp", surface: "console-api", quality: "full", capability: "console" },
  { source: "cdp", surface: "runtime-exception", quality: "full", capability: "console" },
  { source: "cdp", surface: "runtime-object-details", quality: "full", capability: "console" },
  { source: "cdp", surface: "network-lifecycle", quality: "full", capability: "network" },
  { source: "cdp", surface: "network-request-headers", quality: "full", capability: "network" },
  { source: "cdp", surface: "network-response-headers", quality: "full", capability: "network" },
  {
    source: "cdp",
    surface: "network-response-body",
    quality: "full",
    capability: "network-bodies",
  },
  { source: "cdp", surface: "network-initiator", quality: "full", capability: "network" },
  { source: "cdp", surface: "network-timing", quality: "full", capability: "network" },
  { source: "cdp", surface: "websocket-lifecycle", quality: "full", capability: "websocket" },
  { source: "cdp", surface: "websocket-frames", quality: "full", capability: "websocket" },
  { source: "cdp", surface: "storage-snapshot", quality: "full", capability: "storage" },
  { source: "cdp", surface: "cookie-snapshot", quality: "full", capability: "cookies" },
  { source: "cdp", surface: "dom-snapshot", quality: "full", capability: "dom-snapshot" },
  { source: "cdp", surface: "source-map-resolution", quality: "full", capability: "source-maps" },
];

export class CdpEvidenceCollector implements EvidenceCollector {
  readonly id = "cdp";
  readonly provides = CDP_CAPABILITIES;
  readonly offers = CDP_EVIDENCE_OFFERS;
  readonly #cdp: CdpManager;

  constructor(cdp: CdpManager) {
    this.#cdp = cdp;
  }

  async attach(input: EvidenceAttachInput): Promise<EvidenceAttachResult> {
    await this.#cdp.attach(input.tabId);
    return { ok: true, capabilities: CDP_CAPABILITIES, limitations: [] };
  }

  async beginSession(_input: EvidenceBeginSessionInput): Promise<{ limitations: string[] }> {
    // CDP already observes after attach; nothing to arm later.
    return { limitations: [] };
  }

  async detach(): Promise<EvidenceDetachResult> {
    const limitations = this.#cdp.getStorageLimitations();
    try {
      await this.#cdp.detach();
    } catch {
      // Capture already stopped — same tolerance ChromiumRecordingRuntime had.
    }
    return { limitations };
  }

  async reattach(): Promise<EvidenceBeginSessionResult> {
    // CDP stays attached across navigations; nothing to re-arm.
    return { limitations: [] };
  }
}
