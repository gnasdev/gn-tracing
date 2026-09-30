/**
 * Reproduction steps — the collapsed, human-readable form of `user_timeline`.
 *
 * A raw timeline records every scroll tick and keystroke, which is what an
 * investigator needs for correlation but not what a bug report needs as its
 * "steps to reproduce". This module folds that stream into the short ordered
 * list a reporter would have written: "Opened the page, clicked Apply coupon,
 * the POST failed".
 *
 * Same rules as the summary it feeds: deterministic (no wall clock, stable
 * ordering) and privacy-preserving (it only re-reads fields the artifacts
 * already carry — redacted labels stay redacted).
 */

import type { EventView } from "./views";

export interface ReproStep {
  atMs: number | null;
  /**
   * Matches the event `kind` the step was folded from, so existing
   * kind-keyed renderers (player activity labels, report markdown) work
   * unchanged: `navigation`, `click`, `contextmenu`, `scroll`, `key`,
   * `submit`, `focus`, or `event` for everything else.
   */
  kind: string;
  /** Primary text: a URL, control label, joined keys, or scroll distance. */
  label: string;
  /** Secondary text: scroll direction, or the field a `key` group typed into. */
  detail?: string;
}

export interface ReproStepsOptions {
  /** Maximum steps returned. The caller reports truncation itself. */
  limit?: number;
}

/** Consecutive same-direction scrolls inside this gap fold into one step. */
const SCROLL_MERGE_GAP_MS = 2000;
/** Keystrokes inside this gap fold into one "typed" step. */
const KEY_MERGE_GAP_MS = 1500;
/** A focus this close before a key run on the same control is its target. */
const FOCUS_LOOKBACK_MS = 3000;
/** Two navigations to the same URL inside this gap are one step. */
const NAV_DEDUPE_MS = 1500;

export const DEFAULT_REPRO_STEP_LIMIT = 25;

function gapMs(a: number | null, b: number | null): number | null {
  if (a === null || b === null) {
    return null;
  }
  return b - a;
}

function isPrintableKey(label: string): boolean {
  return label.length === 1;
}

/**
 * Joins a run of key labels: printable characters concatenate, named keys keep
 * `{Name}` braces so `a`, `b`, `Enter` reads as `ab{Enter}`.
 */
function joinKeyLabels(events: EventView[]): string {
  return events
    .map((event) => (isPrintableKey(event.label) ? event.label : `{${event.label}}`))
    .join("");
}

/**
 * Folds the event stream into ordered reproduction steps.
 *
 * Merge rules, in order:
 * - consecutive same-direction `scroll` events within `SCROLL_MERGE_GAP_MS`
 *   sum their deltas into one step;
 * - consecutive `key` events within `KEY_MERGE_GAP_MS` join into one step, and
 *   a `focus` on the same control just before the run becomes that step's
 *   `detail` ("typed into") instead of its own step;
 * - repeated `navigation` to the same URL within `NAV_DEDUPE_MS` keeps the
 *   first step only;
 * - everything else passes through one-to-one.
 */
export function buildReproSteps(events: EventView[], options: ReproStepsOptions = {}): ReproStep[] {
  const limit = options.limit ?? DEFAULT_REPRO_STEP_LIMIT;
  const steps: ReproStep[] = [];
  let pendingFocus: EventView | null = null;

  const emit = (step: ReproStep) => {
    if (steps.length < limit) {
      steps.push(step);
    }
  };

  const flushFocus = () => {
    if (pendingFocus) {
      emit({ atMs: pendingFocus.atMs, kind: "focus", label: pendingFocus.label });
      pendingFocus = null;
    }
  };

  for (let i = 0; i < events.length; i++) {
    const event = events[i];

    if (event.kind === "scroll") {
      flushFocus();
      const direction = directionOf(event);
      let totalDelta = 0;
      let j = i;
      while (
        j < events.length &&
        events[j].kind === "scroll" &&
        directionOf(events[j]) === direction
      ) {
        if (j !== i) {
          const gap = gapMs(events[j - 1].atMs, events[j].atMs);
          if (gap === null || gap > SCROLL_MERGE_GAP_MS) {
            break;
          }
        }
        totalDelta += deltaOf(events[j]);
        j++;
      }
      emit({
        atMs: event.atMs,
        kind: "scroll",
        label: totalDelta > 0 ? `${totalDelta}px` : "",
        ...(direction ? { detail: direction } : {}),
      });
      i = j - 1;
      continue;
    }

    if (event.kind === "key") {
      const run: EventView[] = [event];
      let j = i + 1;
      while (j < events.length && events[j].kind === "key") {
        const gap = gapMs(events[j - 1].atMs, events[j].atMs);
        if (gap === null || gap > KEY_MERGE_GAP_MS) {
          break;
        }
        run.push(events[j]);
        j++;
      }
      const keys = joinKeyLabels(run);
      const focusGap = pendingFocus ? gapMs(pendingFocus.atMs, event.atMs) : null;
      const into =
        pendingFocus?.selector &&
        pendingFocus.selector === event.selector &&
        focusGap !== null &&
        focusGap <= FOCUS_LOOKBACK_MS
          ? pendingFocus.label
          : null;
      if (into) {
        pendingFocus = null;
      } else {
        flushFocus();
      }
      emit({
        atMs: event.atMs,
        kind: "key",
        label: keys,
        ...(into ? { detail: into } : {}),
      });
      i = j - 1;
      continue;
    }

    if (event.kind === "focus") {
      // Hold it: only a key run on the same control turns it into "typed
      // into"; anything else flushes it as its own step.
      flushFocus();
      pendingFocus = event;
      continue;
    }

    flushFocus();

    if (event.kind === "navigation") {
      const previous = steps[steps.length - 1];
      const gap = previous ? gapMs(previous.atMs, event.atMs) : null;
      if (
        previous?.kind === "navigation" &&
        previous.label === event.label &&
        gap !== null &&
        gap <= NAV_DEDUPE_MS
      ) {
        continue;
      }
      emit({ atMs: event.atMs, kind: "navigation", label: event.label });
      continue;
    }

    emit({ atMs: event.atMs, kind: event.kind, label: event.label });
  }

  flushFocus();
  return steps;
}

/** Scroll direction comes before the first space in `"down 120px"` labels. */
function directionOf(event: EventView): string {
  return event.label.split(" ")[0] ?? "";
}

function deltaOf(event: EventView): number {
  const match = /(-?\d+)\s*px/.exec(event.label);
  return match ? Math.abs(Number(match[1])) : 0;
}

/**
 * English one-liner for the markdown report and any non-localized surface.
 * Kind-keyed, so a localized caller can re-format from `kind`/`label`/`detail`
 * instead of parsing this string.
 */
export function formatReproStep(step: ReproStep): string {
  switch (step.kind) {
    case "navigation":
      return `Opened ${step.label}`;
    case "click":
      return `Clicked "${step.label}"`;
    case "contextmenu":
      return `Right-clicked "${step.label}"`;
    case "scroll":
      return step.label
        ? `Scrolled ${step.detail ?? ""} ${step.label}`.replace("  ", " ")
        : `Scrolled ${step.detail ?? ""}`.trim();
    case "key": {
      if (step.detail) {
        return `Typed "${step.label}" into "${step.detail}"`;
      }
      // A single named key is a press, not typing: `{Enter}` → "Pressed Enter".
      const single = /^\{([^{}]+)\}$/.exec(step.label);
      return single ? `Pressed ${single[1]}` : `Typed "${step.label}"`;
    }
    case "submit":
      return `Submitted ${step.label}`;
    case "focus":
      return `Focused "${step.label}"`;
    default:
      return step.label;
  }
}
