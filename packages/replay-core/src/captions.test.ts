import { describe, expect, it } from "vitest";
import { buildCaptionsFromEventsJson, buildChaptersVtt } from "./captions";

describe("buildChaptersVtt", () => {
  it("emits one cue per step with monotonic times", () => {
    const vtt = buildChaptersVtt(
      [
        { atMs: 0, kind: "navigation", label: "Opened https://app.example.com" },
        { atMs: 5000, kind: "click", label: "Clicked Pay now" },
        { atMs: null, kind: "scroll", label: "Scrolled down" },
      ],
      { durationMs: 20_000 },
    );
    expect(vtt).toContain("WEBVTT");
    expect(vtt).toContain("00:00:00.000 --> 00:00:05.000");
    expect(vtt).toContain("00:00:05.000 --> 00:00:20.000");
    expect(vtt).toContain("1 · Opened https://app.example.com");
    expect(vtt).toContain("2 · Clicked Pay now");
    // step without a timestamp is skipped
    expect(vtt).not.toContain("Scrolled down");
  });
});

describe("buildCaptionsFromEventsJson", () => {
  const enc = new TextEncoder();

  it("derives chapters from an events.json array", () => {
    const events = enc.encode(
      JSON.stringify([
        { type: "navigation", timestamp: 1_000_000, url: "https://app.example.com" },
        { type: "click", timestamp: 1_005_000, text: "Pay" },
      ]),
    );
    const vtt = buildCaptionsFromEventsJson(events, 1_000_000);
    expect(vtt).not.toBeNull();
    const text = new TextDecoder().decode(vtt!);
    expect(text).toContain("WEBVTT");
    expect(text).toContain("https://app.example.com");
  });

  it("returns null for empty or unparseable events", () => {
    expect(buildCaptionsFromEventsJson(enc.encode("[]"), 0)).toBeNull();
    expect(buildCaptionsFromEventsJson(enc.encode("not json"), 0)).toBeNull();
  });

  it("returns null when startTime is unknown — epoch ms is not a cue time", () => {
    const events = enc.encode(
      JSON.stringify([{ type: "navigation", timestamp: 1_000_000, url: "https://x.test" }]),
    );
    expect(buildCaptionsFromEventsJson(events, null)).toBeNull();
  });
});
