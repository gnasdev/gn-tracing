import { describe, expect, it } from "vitest";

import { syncLanguageToggleButton, type UiLanguage } from "./ui-language";

class LanguageButton {
  textContent: string | null = null;
  title = "";
  dataset: DOMStringMap = {} as DOMStringMap;
  #attributes = new Map<string, string>();

  setAttribute(name: string, value: string): void {
    this.#attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.#attributes.get(name) ?? null;
  }
}

describe("syncLanguageToggleButton", () => {
  it.each([
    ["en", "🇺🇸", "Switch to Vietnamese"],
    ["vi", "🇻🇳", "Switch to English"],
  ] as const)("shows the active language flag when the display language is %s", (language, flag, label) => {
    const button = new LanguageButton();

    syncLanguageToggleButton(language as UiLanguage, button as unknown as HTMLButtonElement);

    expect(button.textContent).toBe(flag);
    expect(button.dataset.language).toBe(language);
    expect(button.getAttribute("aria-label")).toBe(label);
    expect(button.title).toBe(label);
  });
});
