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

export interface ThemePreferenceController {
  refresh: () => void;
  getPreference: () => ThemePreference;
}

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

/** Attach labeled radio inputs that select a specific theme preference. */
export function attachThemePreferenceInputs(
  inputIds: Record<ThemePreference, string>,
): ThemePreferenceController | null {
  const inputs = new Map<ThemePreference, HTMLInputElement>();
  for (const preference of THEME_CYCLE) {
    const input = document.getElementById(inputIds[preference]) as HTMLInputElement | null;
    if (!input) {
      return null;
    }
    inputs.set(preference, input);
  }

  let currentPreference: ThemePreference = readPreferenceFromLocalStorage();

  const paint = (preference: ThemePreference): void => {
    currentPreference = preference;
    document.documentElement.setAttribute("data-theme", resolveTheme(preference));
    document.documentElement.setAttribute("data-theme-preference", preference);
    for (const [option, input] of inputs) {
      input.checked = option === preference;
    }
  };

  const apply = async (preference: ThemePreference): Promise<void> => {
    paint(preference);
    await writePreference(preference);
  };

  // Initial paint from storage (chrome.storage may override localStorage).
  void readPreference().then((preference) => {
    void apply(preference);
  });

  for (const [preference, input] of inputs) {
    input.addEventListener("change", () => {
      if (input.checked) {
        void apply(preference);
      }
    });
  }

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
    refresh: () => {
      paint(currentPreference);
    },
    getPreference: () => currentPreference,
  };
}
