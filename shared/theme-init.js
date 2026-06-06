(() => {
  var t;
  try {
    t = localStorage.getItem("gn_tracing_theme");
    if (t === "light" || t === "dark") {
      document.documentElement.setAttribute("data-theme", t);
    } else if (window.matchMedia?.("(prefers-color-scheme: light)").matches) {
      document.documentElement.setAttribute("data-theme", "light");
    } else {
      document.documentElement.setAttribute("data-theme", "dark");
    }
  } catch {
    document.documentElement.setAttribute("data-theme", "dark");
  }
})();
