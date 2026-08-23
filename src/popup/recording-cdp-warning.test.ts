import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { POPUP_TRANSLATIONS } from "./i18n-catalog";

const popupHtml = readFileSync(resolve(__dirname, "../../popup/popup.html"), "utf8");
const popupSource = readFileSync(resolve(__dirname, "./popup.ts"), "utf8");
const popupCss = readFileSync(resolve(__dirname, "../../popup/popup.css"), "utf8");

describe("popup CDP debugger banner warning", () => {
  it("places an accessible localized warning below recording controls", () => {
    const primaryActions = popupHtml.indexOf(
      'class="recording-actions-row recording-actions-primary"',
    );
    const warning = popupHtml.indexOf('id="cdp-banner-warning"');
    const audioSummary = popupHtml.indexOf('id="audio-settings"');

    expect(primaryActions).toBeGreaterThanOrEqual(0);
    expect(warning).toBeGreaterThan(primaryActions);
    expect(warning).toBeLessThan(audioSummary);
    expect(popupHtml).toContain('class="recording-cdp-warning hidden"');
    expect(popupHtml).toContain('role="status"');
    expect(popupHtml).toContain('data-i18n="recording.cdpBannerWarning"');
  });

  it("shows only while recording where the Chrome debugger API is available", () => {
    expect(popupSource).toContain(
      'const cdpBannerWarning = document.getElementById("cdp-banner-warning") as HTMLElement;',
    );
    expect(popupSource).toContain(
      'cdpBannerWarning.classList.toggle("hidden", !("debugger" in chrome));',
    );
    expect(popupSource).toContain('cdpBannerWarning.classList.add("hidden");');
  });

  it("uses compact warning styling and complete localized copy", () => {
    expect(popupCss).toContain(".recording-cdp-warning {");
    expect(popupCss).toContain(".recording-cdp-warning.hidden {");
    expect(POPUP_TRANSLATIONS.en["recording.cdpBannerWarning"]).toContain("debugging this tab");
    expect(POPUP_TRANSLATIONS.vi["recording.cdpBannerWarning"]).toContain("Chrome");
  });
});
