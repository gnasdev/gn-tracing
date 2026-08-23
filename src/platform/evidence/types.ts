/**
 * The seam that lets a Firefox runtime combine two evidence sources.
 *
 * Chromium gets everything from one CDP session. Firefox needs `webRequest`
 * for network alongside in-page capture for console — two mechanisms that must
 * compose without either runtime knowing about the other's existence. This is
 * the Strategy interface each mechanism implements; `CollectorSet` is the
 * Composite that runs a browser's collectors together.
 *
 * Lifecycle is two-phase on purpose:
 * - `attach` prepares observers (inject scripts, install listeners, open CDP)
 *   while the tab still holds activeTab / before the user commits the share picker.
 * - `beginSession` arms capture for a committed session (in-page START; webRequest
 *   tab scoping). Callers that wait on a cancelable media step must not arm until
 *   that step succeeds, or a cancelled start leaves the page instrumented and
 *   records the picker detour as session evidence.
 *
 * Deliberately narrow: only the lifecycle every collector shares plus the
 * capabilities/limitations it actually delivered. Collector-specific details
 * (CDP source maps, in-page frame-injection failures) stay on the concrete type.
 */

import type { RecordingCapability } from "../../../packages/replay-core/src/schema/package";
import type { EvidenceOffer } from "./surfaces";

export interface EvidenceAttachInput {
  tabId: number;
  sessionId: string;
  /** Surfaces this collector owns for this session after fabric selection. */
  selectedOffers?: readonly EvidenceOffer[];
}

export interface EvidenceBeginSessionInput {
  tabId: number;
  sessionId: string;
  /** The same selected surfaces passed to attach, retained for late arming. */
  selectedOffers?: readonly EvidenceOffer[];
}

export interface EvidenceAttachResult {
  /**
   * True when at least one collector in the set prepared successfully.
   * Product policy is best-effort evidence: one source failing (e.g. CSP-blocked
   * in-page) must not discard another that is live (e.g. webRequest network).
   * Runtimes fail the start only when this is false (nothing prepared).
   */
  ok: boolean;
  /** Capabilities this collector actually delivered, not what it hoped to. */
  capabilities: readonly RecordingCapability[];
  /** Human-readable gaps to surface as recording privacy limitations. */
  limitations: readonly string[];
}

export interface EvidenceDetachResult {
  limitations: readonly string[];
}

/**
 * Result of arming a committed session. Failures become limitations rather than
 * hard errors when the media session is already live — discarding a user-accepted
 * share solely because console re-arm failed is worse than packaging partial evidence.
 */
export interface EvidenceBeginSessionResult {
  /** False only when this collector could not arm evidence capture. */
  active?: boolean;
  limitations: readonly string[];
}

export interface EvidenceCollector {
  readonly id: string;
  /** Surfaces this collector can supply, including source and fidelity. */
  readonly offers: readonly EvidenceOffer[];
  /**
   * Legacy artifact-level declaration kept for attach-result compatibility.
   * Surface selection uses `offers` instead.
   */
  readonly provides: readonly RecordingCapability[];

  /** Prepare observers; do not arm session-scoped capture yet when that is separate. */
  attach(input: EvidenceAttachInput): Promise<EvidenceAttachResult>;

  /**
   * Arm capture after the session is committed (e.g. after the user accepts the
   * share picker). No-op for collectors that already observe continuously after
   * attach (CDP). Safe to call only after a successful attach on this collector.
   *
   * Must not throw for recoverable arm failures: return limitations instead so
   * the runtime can keep a committed media session and package what is available.
   */
  beginSession(input: EvidenceBeginSessionInput): Promise<EvidenceBeginSessionResult>;

  /** Flush in-flight rows, then stop observing. Safe to call when not attached. */
  detach(): Promise<EvidenceDetachResult>;

  /**
   * Re-arm after a navigation destroyed the observer.
   *
   * No-op for collectors whose observer survives navigation (CDP, `webRequest`
   * listeners). Required for in-page capture, whose content-script listeners a
   * navigation always destroys — re-inject and START again.
   */
  reattach(tabId: number, sessionId: string): Promise<EvidenceBeginSessionResult>;
}
