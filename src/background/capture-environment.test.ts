/**
 * Unit tests for `normalizeRecordingUserEvent`, the service-worker gatekeeper
 * that validates and shapes every injected user-event before it is buffered
 * into `events.json`. An unhandled event `type` is dropped, so these tests pin
 * down that click, contextmenu (right click), scroll, and key events all survive
 * with the fields the replay player needs to render input effects on the video.
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
      viewportWidth: 1280,
      viewportHeight: 800,
    });
    expect(event).toMatchObject({
      type: "click",
      x: 12,
      y: 34,
      viewportWidth: 1280,
      viewportHeight: 800,
    });
  });

  it("drops non-positive viewport sizes on click events", () => {
    const event = normalizeRecordingUserEvent({
      type: "click",
      timestamp: 100,
      x: 1,
      y: 2,
      viewportWidth: 0,
      viewportHeight: -10,
    });
    expect(event).toMatchObject({ type: "click", x: 1, y: 2 });
    expect(event && "viewportWidth" in event ? event.viewportWidth : undefined).toBeUndefined();
    expect(event && "viewportHeight" in event ? event.viewportHeight : undefined).toBeUndefined();
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

  it("keeps key events with display label and modifier flags", () => {
    const event = normalizeRecordingUserEvent({
      type: "key",
      timestamp: 400,
      key: "Ctrl+S",
      code: "KeyS",
      ctrlKey: true,
      altKey: false,
      shiftKey: false,
      metaKey: false,
      selector: "body",
    });
    expect(event).toMatchObject({
      type: "key",
      key: "Ctrl+S",
      code: "KeyS",
      ctrlKey: true,
      selector: "body",
    });
    expect(event && "altKey" in event ? event.altKey : undefined).toBeUndefined();
    expect(event && "shiftKey" in event ? event.shiftKey : undefined).toBeUndefined();
    expect(event && "metaKey" in event ? event.metaKey : undefined).toBeUndefined();
  });

  it("drops key events without a display label", () => {
    expect(normalizeRecordingUserEvent({ type: "key", timestamp: 1, key: "  " })).toBeNull();
  });

  it("drops DOM keydown type strings (only type key is accepted)", () => {
    expect(normalizeRecordingUserEvent({ type: "keydown", timestamp: 1, key: "Enter" })).toBeNull();
  });

  it("drops events with an unknown type", () => {
    expect(normalizeRecordingUserEvent({ type: "mousemove", timestamp: 1 })).toBeNull();
  });

  it("drops events without a timestamp", () => {
    expect(normalizeRecordingUserEvent({ type: "click" })).toBeNull();
  });
});
