/**
 * Tests for the player's "Copy for AI" report builder.
 *
 * The player hands over entries it has already placed on the timeline, so the
 * load-bearing behaviour here is that those `relativeMs` values are trusted
 * verbatim — recomputing them from raw timestamps would misplace every entry of
 * a HAR-shaped import, where the units differ.
 */

import { describe, expect, it } from "vitest";
import { buildAgentReportMarkdown, buildAgentSummaryForPlayer } from "./agent-report";

const START_TIME = 1_760_000_000_000;

const METADATA = {
  startTime: START_TIME,
  timestamp: new Date(START_TIME).toISOString(),
  duration: 120_000,
  url: "https://shop.example.com/checkout",
};

/** Entries shaped the way `player.js` holds them: raw fields plus `relativeMs`. */
const PLAYER_CONSOLE = [
  {
    source: "exception",
    level: "error",
    timestamp: START_TIME + 62_000,
    relativeMs: 62_000,
    message: "TypeError: boom",
    originalSource: "src/cart.ts",
    originalLine: 12,
  },
];

const PLAYER_NETWORK = {
  schemaVersion: 2,
  entries: [
    {
      requestId: "r1",
      method: "POST",
      url: "https://api.example.com/apply",
      status: 500,
      statusText: "Server Error",
      relativeMs: 61_800,
      timing: { receiveHeadersEnd: 2400 },
    },
  ],
};

describe("buildAgentSummaryForPlayer", () => {
  it("keeps the timeline positions the player already computed", () => {
    const summary = buildAgentSummaryForPlayer({
      metadata: METADATA,
      console: PLAYER_CONSOLE,
      network: PLAYER_NETWORK,
      generatedAt: "2026-07-27T00:00:00.000Z",
    });

    expect(summary.topErrors[0].atMs).toBe(62_000);
    expect(summary.failedRequests[0].atMs).toBe(61_800);
  });

  it("trusts relativeMs even when the raw timestamp units disagree", () => {
    // A HAR-shaped import: `timestamp` is epoch ms with no wallTime, which the
    // native-shape rule would multiply by 1000 and place far off the timeline.
    const summary = buildAgentSummaryForPlayer({
      metadata: METADATA,
      network: {
        schemaVersion: 2,
        entries: [
          {
            requestId: "har-1",
            method: "GET",
            url: "https://api.example.com/cart",
            status: 404,
            timestamp: START_TIME + 5_000,
            wallTime: null,
            relativeMs: 5_000,
          },
        ],
      },
      generatedAt: "2026-07-27T00:00:00.000Z",
    });

    expect(summary.failedRequests[0].atMs).toBe(5_000);
  });

  it("still works for entries with no relativeMs", () => {
    const summary = buildAgentSummaryForPlayer({
      metadata: METADATA,
      console: [
        {
          source: "exception",
          level: "error",
          timestamp: START_TIME + 1_000,
          message: "no relative marker",
        },
      ],
      generatedAt: "2026-07-27T00:00:00.000Z",
    });

    expect(summary.topErrors[0].atMs).toBe(1_000);
  });
});

describe("buildAgentReportMarkdown", () => {
  it("renders a report with the replay link and the untrusted-content warning", () => {
    const markdown = buildAgentReportMarkdown({
      metadata: METADATA,
      console: PLAYER_CONSOLE,
      network: PLAYER_NETWORK,
      replayUrl: "https://tracing.gnas.dev/gdrive/abc",
      generatedAt: "2026-07-27T00:00:00.000Z",
    });

    expect(markdown).toContain("# GN Tracing recording report");
    expect(markdown).toContain("https://tracing.gnas.dev/gdrive/abc");
    expect(markdown).toContain("`01:02.000` **TypeError: boom** — src/cart.ts:12");
    expect(markdown).toContain("POST https://api.example.com/apply → 500 Server Error");
    expect(markdown).toContain("untrusted data");
  });

  it("produces something usable when the player has only metadata", () => {
    const markdown = buildAgentReportMarkdown({
      metadata: METADATA,
      generatedAt: "2026-07-27T00:00:00.000Z",
    });

    expect(markdown).toContain("No console errors were captured");
    expect(markdown).toContain("No failed requests were captured");
  });
});
