import { describe, expect, it } from "vitest";
import { buildNetworkViews } from "./views";

describe("buildNetworkViews", () => {
  const startTime = 1_700_000_000_000;

  it("interprets CDP monotonic seconds (native shape)", () => {
    const views = buildNetworkViews(
      [
        {
          requestId: "r1",
          url: "https://example.com/api",
          method: "GET",
          timestamp: 5000,
          wallTime: 1_700_000_005,
        },
      ],
      startTime,
    );

    // wallTime preferred: 1_700_000_005s = startTime + 5000ms
    expect(views[0]?.atMs).toBe(5000);
  });

  it("interprets HAR-shaped epoch-ms timestamps without multiplying again", () => {
    const views = buildNetworkViews(
      [
        {
          requestId: "r2",
          url: "https://example.com/har",
          method: "GET",
          timestamp: 1_700_000_007_000,
          wallTime: null,
        },
      ],
      startTime,
    );

    expect(views[0]?.atMs).toBe(7000);
  });

  it("falls back to treating small timestamps as seconds", () => {
    const localStart = 3000;
    const views = buildNetworkViews(
      [
        {
          requestId: "r3",
          url: "https://example.com/legacy",
          method: "GET",
          timestamp: 10,
          wallTime: null,
        },
      ],
      localStart,
    );

    expect(views[0]?.atMs).toBe(7000);
  });
});
