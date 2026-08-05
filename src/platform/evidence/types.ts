/**
 * The seam that lets a Firefox runtime combine two evidence sources.
 *
 * Chromium gets everything from one CDP session. Firefox needs `webRequest`
 * for network (a later phase) alongside in-page capture for console — two
 * mechanisms that must compose without either runtime knowing about the
 * other's existence. This is the Strategy interface each mechanism implements;
 * `CollectorSet` is the Composite that runs a browser's collectors together.
 *
 * Deliberately narrow: only the lifecycle every collector shares (attach,
 * detach, reattach-after-navigation) plus the capabilities/limitations it
 * actually delivered. Anything collector-specific (CDP's source maps, in-page's
 * frame-injection failures) stays on the concrete collector, not here — forcing
 * it into this interface would make every collector implement methods that
 * mean nothing to it.
 */

import type { RecordingCapability } from "../../../packages/replay-core/src/schema/package";

export interface EvidenceAttachInput {
  tabId: number;
  sessionId: string;
  /**
   * Response-body capture policy, mirroring `UploadSettingsStore`. Optional and
   * narrowed to just these two fields (not the whole settings object) so a
   * collector that ignores bodies entirely (CDP reads this from its own
   * settings call) does not need to know the settings shape evolved.
   */
  responseBodyMode?: "off" | "text" | "text-json" | "eligible";
  maxResponseBodyBytes?: number | null;
}

export interface EvidenceAttachResult {
  ok: boolean;
  /** Capabilities this collector actually delivered, not what it hoped to. */
  capabilities: readonly RecordingCapability[];
  /** Human-readable gaps to surface as recording privacy limitations. */
  limitations: readonly string[];
}

export interface EvidenceDetachResult {
  limitations: readonly string[];
}

export interface EvidenceCollector {
  readonly id: string;
  /**
   * Evidence kinds this collector is authoritative for. Used by `CollectorSet`
   * to assert no two collectors in the same set claim the same kind — the
   * invariant that keeps composition safe without a dedupe step.
   */
  readonly provides: readonly RecordingCapability[];

  attach(input: EvidenceAttachInput): Promise<EvidenceAttachResult>;

  /** Flush in-flight rows, then stop observing. Safe to call when not attached. */
  detach(): Promise<EvidenceDetachResult>;

  /**
   * Re-arm after a navigation destroyed the observer.
   *
   * No-op for collectors whose observer survives navigation (CDP, `webRequest`).
   * Required for in-page capture, whose content-script listeners a navigation
   * always destroys.
   */
  reattach(tabId: number, sessionId: string): Promise<void>;
}
