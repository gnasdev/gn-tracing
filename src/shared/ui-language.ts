/**
 * Shared UI language preference for extension full pages
 * (settings, history, drive-auth).
 *
 * Storage is shared so picking EN/VI on one page carries to the others.
 * Markup expects a single click-to-toggle control in the topbar:
 *   <button id="lang-toggle-btn" class="icon-btn gn-lang-toggle" type="button">EN</button>
 */

export type UiLanguage = "en" | "vi";

export const UI_LANGUAGE_STORAGE_KEY = "gn_tracing_ui_language";

const LEGACY_LANGUAGE_STORAGE_KEYS = [
  "gn_tracing_settings_language",
  "gn_tracing_drive_auth_language",
] as const;

function isUiLanguage(value: string | null): value is UiLanguage {
  return value === "en" || value === "vi";
}

function detectBrowserLanguage(): UiLanguage {
  return navigator.language.toLowerCase().startsWith("vi") ? "vi" : "en";
}

export function getOppositeUiLanguage(language: UiLanguage): UiLanguage {
  return language === "en" ? "vi" : "en";
}

/**
 * Resolve the current UI language: shared key, then legacy page keys, then browser.
 */
export function getUiLanguage(): UiLanguage {
  const shared = window.localStorage.getItem(UI_LANGUAGE_STORAGE_KEY);
  if (isUiLanguage(shared)) {
    return shared;
  }

  for (const key of LEGACY_LANGUAGE_STORAGE_KEYS) {
    const legacy = window.localStorage.getItem(key);
    if (isUiLanguage(legacy)) {
      window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, legacy);
      return legacy;
    }
  }

  return detectBrowserLanguage();
}

export function setUiLanguage(language: UiLanguage): void {
  window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, language);
  // Keep legacy keys in sync so older code paths / mid-upgrade tabs stay consistent.
  for (const key of LEGACY_LANGUAGE_STORAGE_KEYS) {
    window.localStorage.setItem(key, language);
  }
}

export function syncLanguageToggleButton(language: UiLanguage, button: HTMLButtonElement): void {
  // Show the language that a click will switch TO (clearer for a toggle).
  const next = getOppositeUiLanguage(language);
  button.textContent = next.toUpperCase();
  button.dataset.language = language;
  button.setAttribute(
    "aria-label",
    language === "en" ? "Switch to Vietnamese" : "Switch to English",
  );
  button.title = language === "en" ? "Switch to Vietnamese" : "Switch to English";
}

/**
 * Wire the shared language toggle button. Returns the language active at attach time.
 * `onChange` is called when the user toggles (not on initial attach).
 */
export function attachLanguageSwitch(options: {
  onChange: (language: UiLanguage) => void;
  buttonId?: string;
}): UiLanguage {
  const button = document.getElementById(
    options.buttonId ?? "lang-toggle-btn",
  ) as HTMLButtonElement | null;
  if (!button) {
    return getUiLanguage();
  }

  const initial = getUiLanguage();
  syncLanguageToggleButton(initial, button);

  button.addEventListener("click", () => {
    const next = getOppositeUiLanguage(getUiLanguage());
    setUiLanguage(next);
    syncLanguageToggleButton(next, button);
    options.onChange(next);
  });

  return initial;
}
