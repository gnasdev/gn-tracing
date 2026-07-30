/**
 * Lightweight i18n for the Solid player (en/vi).
 */
import { createSignal } from "solid-js";
import { DEFAULT_LANGUAGE, TRANSLATIONS, type UiLanguage } from "./catalog";

export type { UiLanguage };
export { TRANSLATIONS };

function isUiLanguage(value: unknown): value is UiLanguage {
  return value === "en" || value === "vi";
}

function detectBrowserLanguage(): UiLanguage {
  const nav = typeof navigator !== "undefined" ? navigator.language : "";
  if (nav.toLowerCase().startsWith("vi")) {
    return "vi";
  }
  return DEFAULT_LANGUAGE;
}

function readStoredLanguage(): UiLanguage | null {
  try {
    const raw = localStorage.getItem("gn-tracing-player-lang");
    return isUiLanguage(raw) ? raw : null;
  } catch {
    return null;
  }
}

const [language, setLanguageSignal] = createSignal<UiLanguage>(
  readStoredLanguage() ?? detectBrowserLanguage(),
);

export function getUiLanguage(): UiLanguage {
  return language();
}

export function setUiLanguage(next: UiLanguage): void {
  setLanguageSignal(next);
  try {
    localStorage.setItem("gn-tracing-player-lang", next);
  } catch {
    // ignore quota / private mode
  }
  if (typeof document !== "undefined") {
    document.documentElement.lang = next;
  }
}

export function t(key: string, replacements: Record<string, string | number> = {}): string {
  const lang = language();
  const table = TRANSLATIONS[lang] || TRANSLATIONS.en;
  const template = table[key] || TRANSLATIONS.en[key] || key;
  return Object.entries(replacements).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    template,
  );
}

export { language };
