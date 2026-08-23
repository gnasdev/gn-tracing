/**
 * CollectorSet: the composite that lets Firefox run in-page + webRequest
 * collectors together without either knowing the other exists.
 *
 * These tests use fakes, not the real CDP/in-page collectors — the point is to
 * prove the composition rules (overlap detection, partial-failure tolerance),
 * not re-test the collectors themselves.
 */
import { describe, expect, it, vi } from "vitest";
import type { RecordingCapability } from "../../../packages/replay-core/src/schema/package";
import { CollectorSet } from "./collector-set";
import type { EvidenceOffer } from "./surfaces";
import type { EvidenceCollector } from "./types";

function fakeCollector(
  overrides: Partial<EvidenceCollector> & {
    id: string;
    provides?: RecordingCapability[];
    offers?: EvidenceOffer[];
  },
): EvidenceCollector {
  return {
    provides: [],
    offers: [],
    attach: vi.fn(async () => ({ ok: true, capabilities: [], limitations: [] })),
    beginSession: vi.fn(async () => ({ limitations: [] })),
    detach: vi.fn(async () => ({ limitations: [] })),
    reattach: vi.fn(async () => ({ limitations: [] })),
    ...overrides,
  };
}

describe("CollectorSet surface selection", () => {
  it("allows overlapping capabilities and chooses the higher-fidelity surface owner", () => {
    const set = new CollectorSet([
      fakeCollector({
        id: "in-page",
        provides: ["network"],
        offers: [
          {
            source: "in-page",
            surface: "network-lifecycle",
            quality: "partial",
            capability: "network",
          },
        ],
      }),
      fakeCollector({
        id: "web-request",
        provides: ["network"],
        offers: [
          {
            source: "web-request",
            surface: "network-lifecycle",
            quality: "full",
            capability: "network",
          },
        ],
      }),
    ]);

    expect(set.evidenceCoverage.surfaces["network-lifecycle"]).toEqual({
      source: "web-request",
      quality: "full",
    });
  });
});

describe("CollectorSet.attach", () => {
  it("runs every collector and merges capabilities and limitations", async () => {
    const a = fakeCollector({
      id: "a",
      provides: ["console"],
      attach: vi.fn(async () => ({
        ok: true,
        capabilities: ["console"] as RecordingCapability[],
        limitations: ["a-note"],
      })),
    });
    const b = fakeCollector({
      id: "b",
      provides: ["network"],
      attach: vi.fn(async () => ({
        ok: true,
        capabilities: ["network"] as RecordingCapability[],
        limitations: ["b-note"],
      })),
    });

    const result = await new CollectorSet([a, b]).attach({ tabId: 1, sessionId: "s1" });

    expect(result.ok).toBe(true);
    expect(result.capabilities).toEqual(["console", "network"]);
    expect(result.limitations).toEqual(["a-note", "b-note"]);
    expect(a.attach).toHaveBeenCalledWith({ tabId: 1, sessionId: "s1" });
  });

  it("one collector failing does not stop the others; ok stays true (best-effort)", async () => {
    // The case this exists for: Firefox in-page blocked by page CSP must not
    // also cost webRequest network evidence. Product policy is best-effort:
    // ok when at least one collector prepared.
    const failing = fakeCollector({
      id: "in-page",
      provides: ["console"],
      attach: vi.fn(async () => ({ ok: false, capabilities: [], limitations: ["blocked by CSP"] })),
    });
    const working = fakeCollector({
      id: "web-request",
      provides: ["network"],
      attach: vi.fn(async () => ({
        ok: true,
        capabilities: ["network"] as RecordingCapability[],
        limitations: [],
      })),
    });

    const result = await new CollectorSet([failing, working]).attach({ tabId: 1, sessionId: "s1" });

    expect(result.ok).toBe(true);
    expect(result.capabilities).toEqual(["network"]);
    expect(result.limitations).toEqual(["blocked by CSP"]);
    expect(working.attach).toHaveBeenCalled();
  });

  it("ok is false only when every collector fails", async () => {
    const a = fakeCollector({
      id: "a",
      provides: ["console"],
      attach: vi.fn(async () => ({ ok: false, capabilities: [], limitations: ["a-fail"] })),
    });
    const b = fakeCollector({
      id: "b",
      provides: ["network"],
      attach: vi.fn(async () => ({ ok: false, capabilities: [], limitations: ["b-fail"] })),
    });

    const result = await new CollectorSet([a, b]).attach({ tabId: 1, sessionId: "s1" });

    expect(result.ok).toBe(false);
    expect(result.capabilities).toEqual([]);
    expect(result.limitations).toEqual(["a-fail", "b-fail"]);
  });

  it("a throwing collector is caught and reported as a limitation, not propagated", async () => {
    const throwing = fakeCollector({
      id: "flaky",
      provides: ["console"],
      attach: vi.fn(async () => {
        throw new Error("boom");
      }),
    });

    const result = await new CollectorSet([throwing]).attach({ tabId: 1, sessionId: "s1" });

    expect(result.ok).toBe(false);
    expect(result.limitations[0]).toContain("flaky");
    expect(result.limitations[0]).toContain("boom");
  });
});

describe("CollectorSet.beginSession, detach and reattach", () => {
  it("begins session on every collector with the same tabId and sessionId", async () => {
    const a = fakeCollector({ id: "a" });
    const b = fakeCollector({ id: "b" });

    const result = await new CollectorSet([a, b]).beginSession({ tabId: 7, sessionId: "s2" });

    expect(a.beginSession).toHaveBeenCalledWith({ tabId: 7, sessionId: "s2" });
    expect(b.beginSession).toHaveBeenCalledWith({ tabId: 7, sessionId: "s2" });
    expect(result.limitations).toEqual([]);
  });

  it("one collector beginSession failure does not abort the others (best-effort)", async () => {
    // After share is committed, in-page START dying must not discard webRequest.
    const failing = fakeCollector({
      id: "in-page",
      provides: ["console"],
      beginSession: vi.fn(async () => {
        throw new Error("Receiving end does not exist");
      }),
    });
    const working = fakeCollector({
      id: "web-request",
      provides: ["network"],
      beginSession: vi.fn(async () => ({ limitations: [] })),
    });

    const result = await new CollectorSet([failing, working]).beginSession({
      tabId: 7,
      sessionId: "s2",
    });

    expect(working.beginSession).toHaveBeenCalled();
    expect(result.limitations.some((line) => /in-page/i.test(line))).toBe(true);
    expect(result.limitations.some((line) => /Receiving end does not exist/i.test(line))).toBe(
      true,
    );
  });

  it("merges beginSession limitations without throwing", async () => {
    const partial = fakeCollector({
      id: "in-page",
      beginSession: vi.fn(async () => ({
        limitations: ["Console evidence could not start after share"],
      })),
    });
    const clean = fakeCollector({ id: "web-request" });

    const result = await new CollectorSet([partial, clean]).beginSession({
      tabId: 1,
      sessionId: "s1",
    });

    expect(result.limitations).toEqual(["Console evidence could not start after share"]);
    expect(clean.beginSession).toHaveBeenCalled();
  });

  it("detaches every collector even when one throws", async () => {
    const throwing = fakeCollector({
      id: "flaky",
      detach: vi.fn(async () => {
        throw new Error("stop failed");
      }),
    });
    const clean = fakeCollector({ id: "clean" });

    const result = await new CollectorSet([throwing, clean]).detach();

    expect(clean.detach).toHaveBeenCalled();
    expect(result.limitations[0]).toContain("flaky");
    expect(result.limitations[0]).toContain("stop failed");
  });

  it("reattaches every collector with the same tabId and sessionId", async () => {
    const a = fakeCollector({ id: "a" });
    const b = fakeCollector({ id: "b" });

    await new CollectorSet([a, b]).reattach(7, "s2");

    expect(a.reattach).toHaveBeenCalledWith(7, "s2");
    expect(b.reattach).toHaveBeenCalledWith(7, "s2");
  });
});

describe("CollectorSet selected lifecycle", () => {
  it("does not arm an unselected overlapping collector", async () => {
    const inPageOffer: EvidenceOffer = {
      source: "in-page",
      surface: "network-lifecycle",
      quality: "partial",
      capability: "network",
    };
    const webRequestOffer: EvidenceOffer = {
      source: "web-request",
      surface: "network-lifecycle",
      quality: "full",
      capability: "network",
    };
    const inPage = fakeCollector({
      id: "in-page",
      offers: [inPageOffer],
      provides: ["network"],
    });
    const webRequest = fakeCollector({
      id: "web-request",
      offers: [webRequestOffer],
      provides: ["network"],
    });
    const set = new CollectorSet([inPage, webRequest]);

    await set.attach({ tabId: 1, sessionId: "s1" });
    await set.beginSession({ tabId: 1, sessionId: "s1" });

    expect(inPage.attach).not.toHaveBeenCalled();
    expect(inPage.beginSession).not.toHaveBeenCalled();
    expect(webRequest.attach).toHaveBeenCalledWith({
      tabId: 1,
      sessionId: "s1",
      selectedOffers: [webRequestOffer],
    });
    expect(webRequest.beginSession).toHaveBeenCalledWith({
      tabId: 1,
      sessionId: "s1",
      selectedOffers: [webRequestOffer],
    });
  });
});

describe("CollectorSet reattach coverage", () => {
  it("removes only the collector that fails to re-arm", async () => {
    const inPageOffer: EvidenceOffer = {
      source: "in-page",
      surface: "console-api",
      quality: "full",
      capability: "console",
    };
    const webRequestOffer: EvidenceOffer = {
      source: "web-request",
      surface: "network-lifecycle",
      quality: "full",
      capability: "network",
    };
    const inPage = fakeCollector({
      id: "in-page",
      offers: [inPageOffer],
      reattach: vi.fn(async () => ({ active: false, limitations: ["bridge unavailable"] })),
    });
    const webRequest = fakeCollector({ id: "web-request", offers: [webRequestOffer] });
    const set = new CollectorSet([inPage, webRequest]);

    await set.attach({ tabId: 1, sessionId: "s1" });
    await set.reattach(1, "s1");

    expect(set.evidenceCoverage.surfaces).toEqual({
      "network-lifecycle": { source: "web-request", quality: "full" },
    });
  });
});
