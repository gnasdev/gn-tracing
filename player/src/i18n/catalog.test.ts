import { describe, expect, it } from "vitest";
import { TRANSLATIONS } from "./catalog";

describe("i18n catalog", () => {
  it("keeps identical en/vi key sets", () => {
    const en = Object.keys(TRANSLATIONS.en).sort();
    const vi = Object.keys(TRANSLATIONS.vi).sort();
    expect(en).toEqual(vi);
    expect(en.length).toBeGreaterThan(50);
  });

  it("labels each mutable media control by its current action", () => {
    expect(TRANSLATIONS.en["controls.play"]).toBe("Play");
    expect(TRANSLATIONS.en["controls.pause"]).toBe("Pause");
    expect(TRANSLATIONS.vi["controls.unmute"]).toBe("Bật tiếng");
    expect(TRANSLATIONS.vi["controls.volume"]).toBe("Âm lượng");
    expect(TRANSLATIONS.en["tabs.network"]).toBe("Network");
    expect(TRANSLATIONS.vi["tabs.network"]).toBe("Mạng");
  });
});
