import { describe, expect, it } from "vitest";
import { POPUP_TRANSLATIONS } from "./i18n-catalog";

describe("POPUP_TRANSLATIONS catalog", () => {
  it("has matching en/vi key sets", () => {
    const enKeys = Object.keys(POPUP_TRANSLATIONS.en).sort();
    const viKeys = Object.keys(POPUP_TRANSLATIONS.vi).sort();
    expect(viKeys).toEqual(enKeys);
    expect(enKeys.length).toBeGreaterThan(50);
  });

  it("includes core recording action strings", () => {
    expect(POPUP_TRANSLATIONS.en["actions.startRecording"]).toMatch(/Start/i);
    expect(POPUP_TRANSLATIONS.vi["actions.startRecording"]).toBeTruthy();
    expect(POPUP_TRANSLATIONS.en["actions.stopUpload"]).toBeTruthy();
  });
});
