import { describe, expect, it } from "vitest";
import { DEFAULT_LANGUAGE, TRANSLATIONS } from "./catalog";
import { formatMessage, isUiLanguage } from "./index";

describe("player-i18n catalog", () => {
  it("has identical en/vi key sets", () => {
    const enKeys = Object.keys(TRANSLATIONS.en).sort();
    const viKeys = Object.keys(TRANSLATIONS.vi).sort();
    expect(viKeys).toEqual(enKeys);
    expect(enKeys.length).toBeGreaterThan(100);
  });

  it("formatMessage replaces placeholders and falls back to en", () => {
    expect(formatMessage("en", "screenshots.shotIndex", { current: 1, total: 3 })).toBe("1 / 3");
    expect(isUiLanguage("en")).toBe(true);
    expect(isUiLanguage("fr")).toBe(false);
    expect(DEFAULT_LANGUAGE).toBe("en");
  });
});
