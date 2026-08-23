/**
 * Capability-level evidence vocabulary and the conversion to package metadata.
 *
 * Providers negotiate these surfaces before a session starts. Artifact writers
 * only see canonical entries after the selected provider has normalized them.
 */

import type {
  EvidenceCoverage,
  EvidenceQuality,
  EvidenceSource,
  EvidenceSurface,
  RecordingCapability,
} from "../../../packages/replay-core/src/schema/package";

export type { EvidenceQuality } from "../../../packages/replay-core/src/schema/package";

export interface EvidenceOffer {
  source: EvidenceSource;
  surface: EvidenceSurface;
  quality: EvidenceQuality;
  capability?: RecordingCapability;
}

export const EVIDENCE_SOURCE_PRIORITY: Readonly<Record<EvidenceSource, number>> = {
  cdp: 0,
  "firefox-rdp": 1,
  "webkit-inspector": 1,
  "webdriver-bidi": 2,
  "web-request": 3,
  "in-page": 4,
};

export function compareEvidenceOffers(left: EvidenceOffer, right: EvidenceOffer): number {
  if (left.quality !== right.quality) {
    return left.quality === "full" ? -1 : 1;
  }
  return EVIDENCE_SOURCE_PRIORITY[left.source] - EVIDENCE_SOURCE_PRIORITY[right.source];
}

export function capabilitiesForEvidenceOffers(
  offers: Iterable<EvidenceOffer>,
): RecordingCapability[] {
  return [...new Set([...offers].flatMap((offer) => (offer.capability ? [offer.capability] : [])))];
}

export function selectEvidenceOffers(offers: Iterable<EvidenceOffer>): EvidenceOffer[] {
  const selected = new Map<EvidenceOffer["surface"], EvidenceOffer>();
  for (const offer of offers) {
    const current = selected.get(offer.surface);
    if (!current || compareEvidenceOffers(offer, current) < 0) {
      selected.set(offer.surface, offer);
    }
  }
  return [...selected.values()];
}

export function coverageFromEvidenceOffers(offers: Iterable<EvidenceOffer>): EvidenceCoverage {
  const surfaces: EvidenceCoverage["surfaces"] = {};
  for (const offer of selectEvidenceOffers(offers)) {
    surfaces[offer.surface] = {
      source: offer.source,
      quality: offer.quality,
    };
  }
  return { schemaVersion: 1, surfaces };
}
