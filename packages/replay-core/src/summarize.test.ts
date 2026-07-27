/**
 * Summary + report tests.
 *
 * `agent-summary.json` is written into packages by the extension AND computed on
 * the fly for older ones, so it has to be deterministic and honestly bounded:
 * the golden snapshot pins the shape, and the truncation assertions prove a
 * capped list never reads as a complete one.
 */

import { describe, expect, it } from "vitest";
import { renderBugReportMarkdown } from "./report";
import { buildAgentSummary, SUMMARY_LIMITS } from "./summarize";
import { buildSampleArtifacts } from "./testing/fixture";

function summarizeSample(overrides: Record<string, unknown> = {}) {
  const artifacts = buildSampleArtifacts();
  return buildAgentSummary({
    metadata: artifacts.metadata,
    console: artifacts.console,
    network: artifacts.network,
    websocket: artifacts.websocket,
    events: artifacts.events,
    privacy: artifacts.privacy,
    report: artifacts.report,
    availableArtifacts: [
      "console",
      "events",
      "metadata",
      "network",
      "privacy",
      "report",
      "websocket",
    ],
    generatedAt: "2026-07-27T00:00:00.000Z",
    ...overrides,
  });
}

describe("buildAgentSummary", () => {
  it("produces a stable summary of the sample recording", () => {
    expect(summarizeSample()).toMatchInlineSnapshot(`
      {
        "capture": {
          "artifacts": [
            "console",
            "events",
            "metadata",
            "network",
            "privacy",
            "report",
            "websocket",
          ],
          "storageProvider": "google-drive",
        },
        "counts": {
          "console": 4,
          "errors": 2,
          "events": 2,
          "network": 2,
          "networkFailed": 1,
          "networkIncomplete": 0,
          "warnings": 1,
          "websocket": 1,
        },
        "environment": {
          "browser": "Chrome 141",
          "extensionVersion": "1.7.2",
          "language": "en-US",
          "timezone": "Asia/Ho_Chi_Minh",
          "viewport": "1512x857",
        },
        "failedRequests": [
          {
            "atMs": 61800,
            "durationMs": 2400,
            "error": null,
            "id": "n-1",
            "method": "POST",
            "resourceType": "xhr",
            "status": 500,
            "statusText": "Internal Server Error",
            "url": "https://api.example.com/cart/apply",
          },
        ],
        "generatedAt": "2026-07-27T00:00:00.000Z",
        "privacy": {
          "limitations": [
            "Response bodies were not captured.",
          ],
          "profile": "balanced",
          "requestBodies": true,
          "responseBodies": false,
        },
        "schemaVersion": 1,
        "session": {
          "durationMs": 120000,
          "pageTitle": "Checkout",
          "pageUrl": "https://shop.example.com/checkout",
          "startedAt": "2025-10-09T08:53:20.000Z",
        },
        "slowRequests": [],
        "timeline": [
          {
            "atMs": 0,
            "kind": "navigation",
            "label": "https://shop.example.com/checkout",
          },
          {
            "atMs": 61200,
            "kind": "click",
            "label": "Apply coupon",
            "selector": "button#apply",
          },
        ],
        "topErrors": [
          {
            "atMs": 62000,
            "hasStack": true,
            "id": "c-1",
            "level": "error",
            "message": "TypeError: Cannot read properties of undefined (reading 'id')",
            "occurrences": 2,
            "origin": {
              "column": 17,
              "file": "src/checkout/cart.ts",
              "line": 128,
              "mapped": true,
            },
          },
        ],
        "truncation": {
          "failedRequests": "1 of 1",
          "slowRequests": "0 of 0",
          "timeline": "2 of 2",
          "topErrors": "1 of 1",
          "websocket": "1 of 1",
        },
        "websocket": [
          {
            "closed": true,
            "frameCount": 2,
            "id": "w-0",
            "receivedCount": 1,
            "sentCount": 1,
            "url": "wss://api.example.com/live",
          },
        ],
      }
    `);
  });

  it("is deterministic across runs", () => {
    expect(JSON.stringify(summarizeSample())).toBe(JSON.stringify(summarizeSample()));
  });

  it("collapses repeated errors instead of listing each occurrence", () => {
    const summary = summarizeSample();
    expect(summary.counts.errors).toBe(2);
    expect(summary.topErrors).toHaveLength(1);
    expect(summary.topErrors[0].occurrences).toBe(2);
  });

  it("caps long lists and reports what was cut", () => {
    const artifacts = buildSampleArtifacts();
    const manyErrors = Array.from({ length: 40 }, (_, index) => ({
      source: "exception",
      level: "error",
      timestamp: artifacts.metadata.startTime + index * 100,
      message: `distinct failure ${index}`,
    }));

    const summary = buildAgentSummary({
      metadata: artifacts.metadata,
      console: manyErrors,
      generatedAt: "2026-07-27T00:00:00.000Z",
    });

    expect(summary.topErrors).toHaveLength(SUMMARY_LIMITS.topErrors);
    expect(summary.truncation.topErrors).toBe(`${SUMMARY_LIMITS.topErrors} of 40`);
  });

  it("survives a package with no optional artifacts", () => {
    const artifacts = buildSampleArtifacts();
    const summary = buildAgentSummary({
      metadata: artifacts.metadata,
      generatedAt: "2026-07-27T00:00:00.000Z",
    });

    expect(summary.counts).toMatchObject({ console: 0, errors: 0, network: 0, events: 0 });
    expect(summary.privacy.limitations).toEqual([]);
    expect(summary.session.pageUrl).toBe("https://shop.example.com/checkout");
  });

  it("does not treat a request that was still in flight as a failure", () => {
    const artifacts = buildSampleArtifacts();
    const summary = buildAgentSummary({
      metadata: artifacts.metadata,
      network: {
        schemaVersion: 2,
        entries: [
          {
            requestId: "pending-1",
            url: "https://api.example.com/stream",
            method: "GET",
            timestamp: (artifacts.metadata.startTime + 1000) / 1000,
            wallTime: (artifacts.metadata.startTime + 1000) / 1000,
            resourceType: "xhr",
            status: null,
            error: null,
          },
        ],
      },
      generatedAt: "2026-07-27T00:00:00.000Z",
    });

    expect(summary.counts.networkFailed).toBe(0);
    expect(summary.counts.networkIncomplete).toBe(1);
  });
});

describe("renderBugReportMarkdown", () => {
  it("quotes the evidence with timestamps and states what was not captured", () => {
    const markdown = renderBugReportMarkdown(summarizeSample(), {
      replayUrl: "https://tracing.gnas.dev/gdrive/abc",
    });

    expect(markdown).toContain("# GN Tracing recording report");
    expect(markdown).toContain("https://tracing.gnas.dev/gdrive/abc");
    expect(markdown).toContain("src/checkout/cart.ts:128");
    expect(markdown).toContain("POST https://api.example.com/cart/apply → 500");
    expect(markdown).toContain("Response bodies were not captured.");
    expect(markdown).toContain("untrusted data");
  });

  it("does not repeat a limitation that both the flags and the artifact state", () => {
    const markdown = renderBugReportMarkdown(summarizeSample());
    const occurrences = markdown.split("Response bodies were not captured.").length - 1;
    expect(occurrences).toBe(1);
  });

  it("narrows to a focus window when asked", () => {
    const markdown = renderBugReportMarkdown(summarizeSample(), {
      focusMs: 62000,
      windowMs: 2000,
    });

    expect(markdown).toContain("src/checkout/cart.ts:128");
    // The navigation at 0 ms falls outside the window.
    expect(markdown).not.toContain("navigation: https://shop.example.com/checkout");
  });
});
