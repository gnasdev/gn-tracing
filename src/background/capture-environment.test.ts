/**
 * Unit tests for `normalizeRecordingUserEvent`, the service-worker gatekeeper
 * that validates and shapes every injected user-event before it is buffered
 * into `events.json`. An unhandled event `type` is dropped, so these tests pin
 * down that click, contextmenu (right click), and scroll events all survive
 * with their coordinates intact — the data the replay player needs to render
 * input effects on the video.
 */

import { describe, expect, it } from "vitest";
import { normalizeRecordingUserEvent } from "./capture-environment";

describe("normalizeRecordingUserEvent", () => {
  it("keeps click coordinates", () => {
    const event = normalizeRecordingUserEvent({
      type: "click",
      timestamp: 100,
      selector: "button#go",
      x: 12,
      y: 34,
    });
    expect(event).toMatchObject({ type: "click", x: 12, y: 34 });
  });

  it("keeps contextmenu (right click) events with coordinates", () => {
    const event = normalizeRecordingUserEvent({
      type: "contextmenu",
      timestamp: 200,
      selector: "div.menu-target",
      text: "Item",
      role: "menuitem",
      x: 56,
      y: 78,
    });
    expect(event).toMatchObject({
      type: "contextmenu",
      x: 56,
      y: 78,
      role: "menuitem",
    });
  });

  it("keeps scroll events with direction, coordinates, and deltaY", () => {
    const event = normalizeRecordingUserEvent({
      type: "scroll",
      timestamp: 300,
      x: 90,
      y: 120,
      direction: "up",
      deltaY: -240,
    });
    expect(event).toMatchObject({
      type: "scroll",
      x: 90,
      y: 120,
      direction: "up",
      deltaY: -240,
    });
  });

  it("defaults an unknown scroll direction to down", () => {
    const event = normalizeRecordingUserEvent({
      type: "scroll",
      timestamp: 300,
      x: 1,
      y: 2,
      direction: "sideways",
    });
    expect(event).toMatchObject({ type: "scroll", direction: "down" });
  });

  it("drops events with an unknown type", () => {
    expect(normalizeRecordingUserEvent({ type: "keydown", timestamp: 1 })).toBeNull();
  });

  it("drops events without a timestamp", () => {
    expect(normalizeRecordingUserEvent({ type: "click" })).toBeNull();
  });
});
