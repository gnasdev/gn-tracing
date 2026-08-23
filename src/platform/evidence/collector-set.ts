/** Capability-aware composite for a browser's evidence collectors. */

import type { EvidenceCoverage } from "../../../packages/replay-core/src/schema/package";
import { coverageFromEvidenceOffers, type EvidenceOffer, selectEvidenceOffers } from "./surfaces";
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
  #selectedOffers: readonly EvidenceOffer[];
  #evidenceCoverage: EvidenceCoverage;
  #activeCollectors = new Set<EvidenceCollector>();
  #activeOffers = new Map<EvidenceCollector, readonly EvidenceOffer[]>();
  #attached = false;

  constructor(collectors: readonly EvidenceCollector[]) {
    this.#collectors = collectors;
    this.#selectedOffers = selectEvidenceOffers(
      collectors.flatMap((collector) => collector.offers),
    );
    this.#evidenceCoverage = coverageFromEvidenceOffers(this.#selectedOffers);
  }

  /** Deterministic owner for each surface before or after a successful attach. */
  get selectedOffers(): readonly EvidenceOffer[] {
    return this.#selectedOffers;
  }

  /** Coverage for collectors that successfully prepared in this session. */
  get evidenceCoverage(): EvidenceCoverage {
    return this.#evidenceCoverage;
  }

  async attach(input: EvidenceAttachInput): Promise<EvidenceAttachResult> {
    const results = await Promise.all(
      this.#collectors.map(async (collector) => {
        const selectedOffers = this.#selectedOffersFor(collector);
        if (selectedOffers?.length === 0) {
          return { collector, selectedOffers, result: null };
        }
        try {
          return {
            collector,
            selectedOffers,
            result: await collector.attach(this.#withSelectedOffers(input, selectedOffers)),
          };
        } catch (error) {
          return {
            collector,
            selectedOffers,
            result: {
              ok: false,
              capabilities: [],
              limitations: [
                `${collector.id} could not start: ${(error as Error)?.message || String(error)}`,
              ],
            },
          };
        }
      }),
    );
    this.#attached = true;
    this.#activeCollectors = new Set(
      results.filter(({ result }) => result?.ok).map(({ collector }) => collector),
    );
    this.#activeOffers = new Map(
      results
        .filter(({ result }) => result?.ok)
        .map(({ collector, selectedOffers }) => [collector, selectedOffers ?? collector.offers]),
    );
    this.#refreshCoverage();
    return {
      ok: results.some(({ result }) => result?.ok),
      capabilities: results.flatMap(({ result }) => result?.capabilities ?? []),
      limitations: results.flatMap(({ result }) => result?.limitations ?? []),
    };
  }

  async beginSession(input: EvidenceBeginSessionInput): Promise<EvidenceBeginSessionResult> {
    const collectors = this.#attached ? [...this.#activeCollectors] : this.#collectors;
    const results = await Promise.all(
      collectors.map(async (collector) => {
        const selectedOffers =
          this.#activeOffers.get(collector) ?? this.#selectedOffersFor(collector);
        try {
          return {
            collector,
            result: await collector.beginSession(this.#withSelectedOffers(input, selectedOffers)),
          };
        } catch (error) {
          return {
            collector,
            result: {
              active: false,
              limitations: [
                `${collector.id} could not arm: ${(error as Error)?.message || String(error)}`,
              ],
            },
          };
        }
      }),
    );
    for (const { collector, result } of results) {
      if (result.active === false) {
        this.#activeCollectors.delete(collector);
        this.#activeOffers.delete(collector);
      }
    }
    this.#refreshCoverage();
    return { limitations: results.flatMap(({ result }) => result.limitations) };
  }

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

  async reattach(tabId: number, sessionId: string): Promise<void> {
    const collectors = this.#attached ? [...this.#activeCollectors] : this.#collectors;
    const results = await Promise.all(
      collectors.map(async (collector) => ({
        collector,
        result: (await collector.reattach(tabId, sessionId)) ?? { limitations: [] },
      })),
    );
    for (const { collector, result } of results) {
      if (result.active === false) {
        this.#activeCollectors.delete(collector);
        this.#activeOffers.delete(collector);
      }
    }
    this.#refreshCoverage();
  }

  #selectedOffersFor(collector: EvidenceCollector): readonly EvidenceOffer[] | undefined {
    // Collectors without offers are legacy test doubles. Production collectors
    // must declare offers so an empty selection means they are not activated.
    if (collector.offers.length === 0) {
      return undefined;
    }
    return this.#selectedOffers.filter((offer) => collector.offers.includes(offer));
  }

  #withSelectedOffers<T extends EvidenceAttachInput | EvidenceBeginSessionInput>(
    input: T,
    selectedOffers: readonly EvidenceOffer[] | undefined,
  ): T {
    return selectedOffers ? { ...input, selectedOffers } : input;
  }

  #refreshCoverage(): void {
    this.#selectedOffers = selectEvidenceOffers([...this.#activeOffers.values()].flat());
    this.#evidenceCoverage = coverageFromEvidenceOffers(this.#selectedOffers);
  }
}
