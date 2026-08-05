/**
 * Composite: run a browser's evidence collectors as one unit.
 *
 * Chromium's set holds one collector (CDP does everything). Firefox's set holds
 * two (in-page for console/websocket, `webRequest` for network) — this is the
 * seam that lets that composition work without either collector knowing the
 * other exists.
 */

import type {
  EvidenceAttachInput,
  EvidenceAttachResult,
  EvidenceBeginSessionInput,
  EvidenceBeginSessionResult,
  EvidenceCollector,
  EvidenceDetachResult,
} from "./types";

export class CollectorSet {
  readonly #collectors: readonly EvidenceCollector[];

  constructor(collectors: readonly EvidenceCollector[]) {
    assertNoOverlap(collectors);
    this.#collectors = collectors;
  }

  /**
   * Prepare every collector in parallel and merge the results.
   *
   * One collector failing does not fail the others: Firefox's in-page capture
   * being blocked by a strict page CSP must not also lose `webRequest` network
   * evidence, and vice versa. A collector that failed contributes no
   * capabilities and its own limitation instead of throwing.
   *
   * `ok` is true when **at least one** collector prepared successfully (best-
   * effort evidence). The runtime throws only when every collector failed.
   */
  async attach(input: EvidenceAttachInput): Promise<EvidenceAttachResult> {
    const results = await Promise.all(
      this.#collectors.map(async (collector) => {
        try {
          return await collector.attach(input);
        } catch (error) {
          return {
            ok: false,
            capabilities: [],
            limitations: [
              `${collector.id} could not start: ${(error as Error)?.message || String(error)}`,
            ],
          };
        }
      }),
    );

    return {
      ok: results.some((result) => result.ok),
      capabilities: results.flatMap((result) => result.capabilities),
      limitations: results.flatMap((result) => result.limitations),
    };
  }

  /**
   * Arm every collector for a committed session.
   *
   * Best-effort like `attach`: one collector throwing or returning limitations
   * must not abort the others. After the user has already accepted screen share,
   * failing the whole start solely because console re-arm failed would discard
   * a live media session for nothing recoverable.
   */
  async beginSession(input: EvidenceBeginSessionInput): Promise<EvidenceBeginSessionResult> {
    const results = await Promise.all(
      this.#collectors.map(async (collector) => {
        try {
          return await collector.beginSession(input);
        } catch (error) {
          return {
            limitations: [
              `${collector.id} could not arm: ${(error as Error)?.message || String(error)}`,
            ],
          };
        }
      }),
    );
    return { limitations: results.flatMap((result) => result.limitations) };
  }

  /** Detach every collector, best-effort: one failing must not skip the rest. */
  async detach(): Promise<EvidenceDetachResult> {
    const results = await Promise.all(
      this.#collectors.map(async (collector) => {
        try {
          return await collector.detach();
        } catch (error) {
          return {
            limitations: [
              `${collector.id} stop failed: ${(error as Error)?.message || String(error)}`,
            ],
          };
        }
      }),
    );
    return { limitations: results.flatMap((result) => result.limitations) };
  }

  /** Re-arm every collector after a navigation; no-op ones return immediately. */
  async reattach(tabId: number, sessionId: string): Promise<void> {
    await Promise.all(this.#collectors.map((collector) => collector.reattach(tabId, sessionId)));
  }
}

/**
 * Two collectors claiming the same evidence kind would silently double-report
 * or race on which one "wins" in storage. Failing fast at construction is
 * cheaper than debugging a duplicated console entry later.
 */
function assertNoOverlap(collectors: readonly EvidenceCollector[]): void {
  const owner = new Map<string, string>();
  for (const collector of collectors) {
    for (const kind of collector.provides) {
      const existing = owner.get(kind);
      if (existing) {
        throw new Error(
          `EvidenceCollector overlap: both "${existing}" and "${collector.id}" claim "${kind}"`,
        );
      }
      owner.set(kind, collector.id);
    }
  }
}
