/**
 * What the video actually contains, stated honestly in the privacy limitations.
 *
 * Firefox cannot capture a single tab: it "allows windows and screens only to be
 * captured with getDisplayMedia()", while Chrome also offers tabs. So a Firefox
 * recording always contains more than the recorded tab — at minimum the browser
 * chrome, and for a whole-screen pick every other app visible on that screen. The
 * package must say so rather than implying a tab-scoped capture.
 *
 * Signals differ per engine, measured on Firefox 153:
 * - Chromium reports `displaySurface` directly ("browser" | "window" | "monitor").
 * - Firefox omits `displaySurface` from `getSettings()` entirely and names the
 *   surface only in `track.label` — "Primary Monitor" for a whole screen, the
 *   window title for a window.
 */

export type CapturedSurface = {
  /** `MediaStreamTrack.label`. The only surface signal Firefox provides. */
  label?: string;
  /** Chromium-only; absent on Firefox 153. */
  displaySurface?: string;
};

/** Labels Firefox uses for a whole screen; the window path uses the window title. */
const SCREEN_LABEL_PATTERN = /\b(monitor|screen|display)\b/i;

function quote(label: string): string {
  return label ? `"${label}"` : "an unnamed surface";
}

/**
 * A limitation string, or null when the capture really was tab-scoped.
 *
 * Returns null for `displaySurface === "browser"` (a Chromium tab capture) and for
 * a capture with no usable signal at all, so this never invents a warning.
 */
export function describeCaptureSurfaceLimitation(surface: CapturedSurface): string | null {
  const displaySurface = (surface.displaySurface || "").toLowerCase();
  const label = surface.label || "";

  if (displaySurface === "browser") {
    // Tab capture — the video contains only the recorded tab.
    return null;
  }

  if (displaySurface === "monitor") {
    return (
      "Screen sharing captured an entire screen, so anything else visible on that " +
      "screen is in the video, not just the recorded tab."
    );
  }

  if (displaySurface === "window") {
    return (
      `Screen sharing captured a window (${quote(label)}), so the video includes the ` +
      "browser interface and any other tab shown in that window, not just the recorded tab."
    );
  }

  if (!label) {
    // No signal at all — say nothing rather than guess.
    return null;
  }

  if (SCREEN_LABEL_PATTERN.test(label)) {
    return (
      `Screen sharing captured an entire screen (${quote(label)}), so anything else ` +
      "visible on that screen is in the video, not just the recorded tab."
    );
  }

  // Firefox window pick: label is the window title, and a tab pick is impossible.
  return (
    `Screen sharing captured a window (${quote(label)}), so the video includes the ` +
    "browser interface and any other tab shown in that window, not just the recorded tab."
  );
}
