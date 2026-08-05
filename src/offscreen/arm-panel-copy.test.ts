/**
 * Firefox arm panel copy must describe what Firefox actually does.
 *
 * Firefox 153 reports `displaySurface=false` in getSupportedConstraints(), so its
 * getDisplayMedia picker only offers a window or a whole screen — never a single
 * tab, and no constraint narrows it. Copy promising "share this tab" led a user
 * to share their entire screen and record everything on it.
 *
 * The error message for a missing transient activation names this button, so the
 * two must not drift apart.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { describeDisplayCaptureError } from "../media-pipeline/record-session";

const armPanelHtml = readFileSync(resolve(__dirname, "../../offscreen/offscreen.html"), "utf8");

/** Label rendered on #arm-btn, as scraped from the shipped markup. */
function armButtonLabel(): string {
  const match = armPanelHtml.match(/<button[^>]*id="arm-btn"[^>]*>([\s\S]*?)<\/button>/);
  const label = match?.[1]?.trim();
  if (!label) {
    throw new Error("offscreen.html no longer has a #arm-btn with a text label.");
  }
  return label;
}

describe("Firefox arm panel copy", () => {
  it("does not promise tab sharing, which Firefox cannot do", () => {
    expect(armPanelHtml).not.toMatch(/Share this tab/i);
    expect(armPanelHtml).not.toMatch(/pick the tab you want to record/i);
  });

  it("says a window or whole screen is what gets shared", () => {
    expect(armPanelHtml).toMatch(/window or a whole screen/i);
    expect(armPanelHtml).toMatch(/cannot share a single tab/i);
    // Sharing a whole screen captures more than the recording is about; say so.
    expect(armPanelHtml).toMatch(/records everything else on it/i);
    // Steer the user to the Firefox window holding the target, not a random screen.
    expect(armPanelHtml).toMatch(/Firefox window/i);
    expect(armPanelHtml).toMatch(/Prefer a window over a whole screen/i);
  });

  it("page-host timeout never says Share this tab", () => {
    const pageHost = readFileSync(resolve(__dirname, "../platform/media/page-host.ts"), "utf8");
    expect(pageHost).not.toMatch(/Share this tab/i);
    expect(pageHost).toContain("Choose what to share");
  });

  it("keeps the activation error message pointing at the real button label", () => {
    const label = armButtonLabel();
    const message = describeDisplayCaptureError(
      new DOMException("needs a gesture", "InvalidStateError"),
    ).message;
    expect(message).toContain(label);
  });

  it("matches the shared FIREFOX_ARM_BUTTON_LABEL constant", async () => {
    const { FIREFOX_ARM_BUTTON_LABEL } = await import("../shared/firefox-arm-copy");
    expect(armButtonLabel()).toBe(FIREFOX_ARM_BUTTON_LABEL);
  });
});
