/**
 * Early theme bootstrap (runs in <head> before paint).
 *
 * Preference key `gn_tracing_theme`: "system" | "light" | "dark".
 * `data-theme` is always resolved to "light" | "dark" for CSS.
 * `data-theme-preference` stores the user choice (including system).
 */
(() => {
  try {
    const saved = localStorage.getItem("gn_tracing_theme");
    const preference =
      saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
    document.documentElement.setAttribute("data-theme-preference", preference);

    if (preference === "light" || preference === "dark") {
      document.documentElement.setAttribute("data-theme", preference);
      return;
    }

    const systemLight = window.matchMedia?.("(prefers-color-scheme: light)").matches;
    document.documentElement.setAttribute("data-theme", systemLight ? "light" : "dark");
  } catch {
    document.documentElement.setAttribute("data-theme", "dark");
    document.documentElement.setAttribute("data-theme-preference", "system");
  }
})();
