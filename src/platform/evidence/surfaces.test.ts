import { describe, expect, it } from "vitest";
import {
  capabilitiesForEvidenceOffers,
  compareEvidenceOffers,
  coverageFromEvidenceOffers,
  type EvidenceOffer,
} from "./surfaces";

describe("evidence surface offers", () => {
  it("prefers full-fidelity evidence, then the deterministic source priority", () => {
    const cdp: EvidenceOffer = {
      source: "cdp",
      surface: "network-response-body",
      quality: "full",
      capability: "network-bodies",
    };
    const inPage: EvidenceOffer = {
      source: "in-page",
      surface: "network-response-body",
      quality: "partial",
      capability: "network-bodies",
    };

    expect(compareEvidenceOffers(cdp, inPage)).toBeLessThan(0);
    expect(coverageFromEvidenceOffers([inPage, cdp])).toEqual({
      schemaVersion: 1,
      surfaces: {
        "network-response-body": { source: "cdp", quality: "full" },
      },
    });
  });

  it("derives unique producer capabilities from offered surfaces", () => {
    const offers: EvidenceOffer[] = [
      {
        source: "web-request",
        surface: "network-lifecycle",
        quality: "full",
        capability: "network",
      },
      {
        source: "web-request",
        surface: "network-timing",
        quality: "partial",
        capability: "network",
      },
      { source: "in-page", surface: "console-api", quality: "full", capability: "console" },
    ];

    expect(capabilitiesForEvidenceOffers(offers)).toEqual(["network", "console"]);
  });
});
