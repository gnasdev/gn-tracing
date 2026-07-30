import { describe, expect, it } from "vitest";
import { TRANSLATIONS } from "./catalog";

describe("i18n catalog", () => {
  it("keeps identical en/vi key sets", () => {
    const en = Object.keys(TRANSLATIONS.en).sort();
    const vi = Object.keys(TRANSLATIONS.vi).sort();
    expect(en).toEqual(vi);
    expect(en.length).toBeGreaterThan(50);
  });
});
