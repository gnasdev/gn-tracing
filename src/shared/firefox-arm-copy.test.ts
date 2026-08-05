/**
 * Firefox arm label is one shared constant used by timeout, InvalidStateError,
 * and the shipped arm-panel button text.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { describeDisplayCaptureError } from "../media-pipeline/record-session";
import {
  describeFirefoxArmInvalidStateMessage,
  describeFirefoxArmTimeoutMessage,
  FIREFOX_ARM_BUTTON_LABEL,
} from "./firefox-arm-copy";

describe("FIREFOX_ARM_BUTTON_LABEL single source", () => {
  it("matches offscreen.html #arm-btn text", () => {
    const html = readFileSync(resolve(__dirname, "../../offscreen/offscreen.html"), "utf8");
    const match = html.match(/<button[^>]*id="arm-btn"[^>]*>([\s\S]*?)<\/button>/);
    expect(match?.[1]?.trim()).toBe(FIREFOX_ARM_BUTTON_LABEL);
  });

  it("is used by timeout and InvalidState messages", () => {
    expect(describeFirefoxArmTimeoutMessage()).toContain(FIREFOX_ARM_BUTTON_LABEL);
    expect(describeFirefoxArmTimeoutMessage()).not.toMatch(/Share this tab/i);
    expect(describeFirefoxArmInvalidStateMessage()).toContain(FIREFOX_ARM_BUTTON_LABEL);
    expect(describeDisplayCaptureError(new DOMException("x", "InvalidStateError")).message).toBe(
      describeFirefoxArmInvalidStateMessage(),
    );
  });

  it("page-host timeout path imports the shared helper", () => {
    const pageHost = readFileSync(resolve(__dirname, "../platform/media/page-host.ts"), "utf8");
    expect(pageHost).toContain("describeFirefoxArmTimeoutMessage");
    expect(pageHost).not.toMatch(/Share this tab/i);
  });
});
