/**
 * GN Tracing Theme System
 *
 * Preference cycles like the replay player: System → Light → Dark.
 * - `gn_tracing_theme` stores preference: "system" | "light" | "dark"
 * - `data-theme` is always resolved "light" | "dark" for CSS
 * - `data-theme-preference` stores the raw preference (including system)
 *
 * Persistence: chrome.storage.local (extension) + localStorage (theme-init.js /
 * player share the same key).
 */

const THEME_STORAGE_KEY = "gn_tracing_theme";
const THEME_CYCLE = ["system", "light", "dark"] as const;

export type ThemePreference = (typeof THEME_CYCLE)[number];
export type ThemeMode = "light" | "dark";

export interface ThemeToggleLabels {
  system: string;
  light: string;
  dark: string;
  /** e.g. "Theme: {label}" */
  aria: string;
  /** e.g. "Theme: {label} (follows OS). Click to cycle System → Light → Dark." */
  titleSystem: string;
  /** e.g. "Theme: {label}. Click to cycle System → Light → Dark." */
  titleFixed: string;
}

export interface ThemeToggleController {
  refreshLabels: () => void;
  getPreference: () => ThemePreference;
}

const DEFAULT_LABELS: ThemeToggleLabels = {
  system: "System",
  light: "Light",
  dark: "Dark",
  aria: "Theme: {label}",
  titleSystem: "Theme: {label} (follows OS). Click to cycle System → Light → Dark.",
  titleFixed: "Theme: {label}. Click to cycle System → Light → Dark.",
};

/** Phosphor class names (same set as the player theme toggle). */
const THEME_ICONS: Record<ThemePreference, string> = {
  system: "ph ph-desktop",
  light: "ph ph-sun",
  dark: "ph ph-moon",
};

function normalizePreference(value: unknown): ThemePreference | null {
  if (value === "system" || value === "light" || value === "dark") {
    return value;
  }
  return null;
}

function systemPrefersLight(): boolean {
  return Boolean(window.matchMedia?.("(prefers-color-scheme: light)").matches);
}

function resolveTheme(preference: ThemePreference): ThemeMode {
  if (preference === "light" || preference === "dark") {
    return preference;
  }
  return systemPrefersLight() ? "light" : "dark";
}

function applyTemplate(template: string, label: string): string {
  return template.replaceAll("{label}", label);
}

function readPreferenceFromLocalStorage(): ThemePreference {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    return normalizePreference(saved) || "system";
  } catch {
    return "system";
  }
}

async function readPreference(): Promise<ThemePreference> {
  try {
    const result = await chrome.storage.local.get(THEME_STORAGE_KEY);
    const fromChrome = normalizePreference(result[THEME_STORAGE_KEY]);
    if (fromChrome) {
      return fromChrome;
    }
  } catch {
    // Non-extension context or storage unavailable.
  }
  return readPreferenceFromLocalStorage();
}

async function writePreference(preference: ThemePreference): Promise<void> {
  const resolved = resolveTheme(preference);
  document.documentElement.setAttribute("data-theme", resolved);
  document.documentElement.setAttribute("data-theme-preference", preference);

  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // ignore
  }

  try {
    await chrome.storage.local.set({ [THEME_STORAGE_KEY]: preference });
  } catch {
    // Non-extension context.
  }
}

/**
 * Attach theme toggle: System → Light → Dark (same cycle as the player).
 * Updates icon + aria/title; follows OS when preference is System.
 */
export function attachThemeToggle(
  buttonId: string,
  iconId?: string,
  options?: { getLabels?: () => ThemeToggleLabels },
): ThemeToggleController | null {
  const btn = document.getElementById(buttonId) as HTMLButtonElement | null;
  if (!btn) {
    return null;
  }

  const icon = iconId ? document.getElementById(iconId) : null;
  let currentPreference: ThemePreference = readPreferenceFromLocalStorage();

  const getLabels = (): ThemeToggleLabels => {
    const labels = options?.getLabels?.();
    return labels ? { ...DEFAULT_LABELS, ...labels } : DEFAULT_LABELS;
  };

  const paint = (preference: ThemePreference): void => {
    currentPreference = preference;
    const resolved = resolveTheme(preference);
    document.documentElement.setAttribute("data-theme", resolved);
    document.documentElement.setAttribute("data-theme-preference", preference);

    if (icon) {
      // Icon host is an <i> (or span); set Phosphor classes for desktop/sun/moon.
      icon.className = THEME_ICONS[preference];
      if (icon instanceof HTMLElement) {
        icon.setAttribute("aria-hidden", "true");
      }
    }

    const labels = getLabels();
    const label =
      preference === "light" ? labels.light : preference === "dark" ? labels.dark : labels.system;
    const title =
      preference === "system"
        ? applyTemplate(labels.titleSystem, label)
        : applyTemplate(labels.titleFixed, label);
    btn.setAttribute("aria-label", applyTemplate(labels.aria, label));
    btn.title = title;
  };

  const apply = async (preference: ThemePreference): Promise<void> => {
    paint(preference);
    await writePreference(preference);
  };

  // Initial paint from storage (chrome.storage may override localStorage).
  void readPreference().then((preference) => {
    void apply(preference);
  });

  btn.addEventListener("click", () => {
    const index = THEME_CYCLE.indexOf(currentPreference);
    const next = THEME_CYCLE[(index + 1) % THEME_CYCLE.length];
    void apply(next);
  });

  // When preference is System, follow OS light/dark changes live.
  const media = window.matchMedia?.("(prefers-color-scheme: light)");
  if (media) {
    const onSystemThemeChange = () => {
      if (currentPreference === "system") {
        void apply("system");
      }
    };
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", onSystemThemeChange);
    } else if (typeof media.addListener === "function") {
      media.addListener(onSystemThemeChange);
    }
  }

  // Keep multi-surface extension pages in sync when preference changes elsewhere.
  try {
    chrome.storage?.onChanged?.addListener((changes, area) => {
      if (area !== "local" || !changes[THEME_STORAGE_KEY]) {
        return;
      }
      const next = normalizePreference(changes[THEME_STORAGE_KEY].newValue);
      if (next && next !== currentPreference) {
        paint(next);
        try {
          localStorage.setItem(THEME_STORAGE_KEY, next);
        } catch {
          // ignore
        }
      }
    });
  } catch {
    // ignore
  }

  return {
    refreshLabels: () => {
      paint(currentPreference);
    },
    getPreference: () => currentPreference,
  };
}
