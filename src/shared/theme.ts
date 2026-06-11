/**
 * GN Tracing Theme System
 * Handles light/dark mode toggle and persistence.
 * Works across extension pages (popup, settings, history, auth) and standalone player.
 */

const THEME_STORAGE_KEY = "gn_tracing_theme";

type ThemeMode = "light" | "dark";

/**
 * Get the current theme from storage or system preference.
 */
async function getTheme(): Promise<ThemeMode> {
  try {
    const result = await chrome.storage.local.get(THEME_STORAGE_KEY);
    if (result[THEME_STORAGE_KEY]) {
      return result[THEME_STORAGE_KEY] as ThemeMode;
    }
  } catch {
    // Fallback for non-extension contexts (standalone player)
    const localTheme = localStorage.getItem(THEME_STORAGE_KEY);
    if (localTheme === "light" || localTheme === "dark") {
      return localTheme;
    }
  }

  // Default to system preference, fallback dark
  if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) {
    return "light";
  }
  return "dark";
}

/**
 * Set theme and persist to storage.
 */
async function setTheme(mode: ThemeMode): Promise<void> {
  document.documentElement.setAttribute("data-theme", mode);

  try {
    await chrome.storage.local.set({ [THEME_STORAGE_KEY]: mode });
  } catch {
    // Fallback for standalone player
    localStorage.setItem(THEME_STORAGE_KEY, mode);
  }
}

/**
 * Toggle between light and dark.
 */
async function toggleTheme(): Promise<ThemeMode> {
  const current = await getTheme();
  const next = current === "dark" ? "light" : "dark";
  await setTheme(next);
  return next;
}

/**
 * Initialize theme on page load.
 * Call this early (ideally in a script in <head> before any render).
 */
async function initTheme(): Promise<void> {
  const theme = await getTheme();
  document.documentElement.setAttribute("data-theme", theme);
}

/**
 * Get sun/moon icon SVG string based on current theme.
 */
function getThemeIconSvg(mode: ThemeMode): string {
  if (mode === "light") {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>`;
  }
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
}

/**
 * Attach theme toggle behavior to existing DOM elements.
 * Expects a button and an inner icon element with IDs.
 */
export function attachThemeToggle(buttonId: string, iconId?: string): void {
  const btn = document.getElementById(buttonId);
  if (!btn) return;

  const icon = iconId ? document.getElementById(iconId) : null;

  const updateIcon = (mode: ThemeMode) => {
    if (icon) {
      icon.innerHTML = getThemeIconSvg(mode);
    }
  };

  void initTheme().then(() => {
    const current = document.documentElement.getAttribute("data-theme") || "dark";
    updateIcon(current as ThemeMode);
  });

  btn.addEventListener("click", async () => {
    const newTheme = await toggleTheme();
    updateIcon(newTheme);
  });
}
