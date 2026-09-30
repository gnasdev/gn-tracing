import { describe, expect, it } from "vitest";
import { investigateRecording } from "./investigate";
import type { AgentSummary } from "./summarize";

function baseSummary(overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    schemaVersion: 2,
    generatedAt: "2026-01-01T00:00:00.000Z",
    session: {
      pageUrl: "https://app.example.com/checkout",
      pageTitle: "Checkout",
      startedAt: "2026-01-01T00:00:00.000Z",
      durationMs: 30_000,
    },
    environment: {
      browser: "Chrome",
      extensionVersion: "1.8.0",
      viewport: "1280x800",
      language: "en",
      timezone: "UTC",
    },
    capture: { storageProvider: "google-drive", artifacts: ["console", "network", "events"] },
    counts: {
      console: 10,
      errors: 1,
      warnings: 0,
      network: 20,
      networkFailed: 1,
      networkIncomplete: 0,
      websocket: 0,
      events: 5,
    },
    topErrors: [],
    failedRequests: [],
    slowRequests: [],
    websocket: [],
    timeline: [],
    reproSteps: [],
    privacy: { profile: "custom", responseBodies: true },
    limitations: [],
    ...overrides,
  } as AgentSummary;
}

describe("investigateRecording", () => {
  it("produces a high-confidence verdict from source-mapped errors", () => {
    const summary = baseSummary({
      topErrors: [
        {
          id: "e1",
          atMs: 1200,
          level: "error",
          message: "Cannot read properties of null",
          origin: { file: "src/cart/reducer.ts", line: 42, mapped: true },
          occurrences: 2,
          hasStack: true,
        },
      ],
      reproSteps: [{ atMs: 300, kind: "click", label: "Pay now" }],
    });
    const result = investigateRecording(summary);
    expect(result.confidence).toBe("high");
    expect(result.markdown).toContain("src/cart/reducer.ts:42");
    expect(result.markdown).toContain("Steps to reproduce");
    expect(result.verdict).toContain("Cannot read properties of null");
  });

  it("falls back to failed requests when there are no errors", () => {
    const summary = baseSummary({
      counts: { ...baseSummary().counts, errors: 0 },
      failedRequests: [
        {
          id: "n1",
          atMs: 900,
          method: "POST",
          url: "https://api.example.com/pay",
          status: 500,
          statusText: "Internal Server Error",
          durationMs: 400,
          resourceType: "fetch",
          error: null,
        },
      ],
    });
    const result = investigateRecording(summary);
    expect(result.confidence).toBe("medium");
    expect(result.markdown).toContain("failed requests");
    expect(result.markdown).toContain("HTTP 500");
    expect(result.markdown).toContain("server error");
  });

  it("reports insufficient evidence on an empty package", () => {
    const result = investigateRecording(
      baseSummary({
        counts: {
          console: 0,
          errors: 0,
          warnings: 0,
          network: 0,
          networkFailed: 0,
          networkIncomplete: 0,
          websocket: 0,
          events: 0,
        },
      }),
    );
    expect(result.confidence).toBe("low");
    expect(result.markdown).toContain("GN Tracing investigation");
  });
});
