/**
 * Production player i18n — single EN/VI catalog source.
 */

import { DEFAULT_LANGUAGE, TRANSLATIONS, type UiLanguage } from "./catalog";

export type { UiLanguage };
export { DEFAULT_LANGUAGE, TRANSLATIONS };

export function isUiLanguage(value: unknown): value is UiLanguage {
  return value === "en" || value === "vi";
}

/**
 * Format a catalog key with `{name}` replacements.
 */
export function formatMessage(
  language: UiLanguage,
  key: string,
  replacements: Record<string, string | number> = {},
): string {
  const table = TRANSLATIONS[language] || TRANSLATIONS.en;
  const enTable = TRANSLATIONS.en;
  const template =
    (table as Record<string, string>)[key] || (enTable as Record<string, string>)[key] || key;
  return Object.entries(replacements).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    template,
  );
}
