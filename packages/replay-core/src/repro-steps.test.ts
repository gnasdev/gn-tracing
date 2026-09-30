/**
 * Repro-step folding tests.
 *
 * The same stream that pads a timeline to hundreds of rows must fold into the
 * handful of steps a bug report leads with — scroll ticks summed, keystrokes
 * joined, and a focus folded into the "typed into" of its key run.
 */

import { describe, expect, it } from "vitest";
import { buildReproSteps, formatReproStep, type ReproStep } from "./repro-steps";
import type { EventView } from "./views";

function ev(kind: string, atMs: number, label: string, extra: Partial<EventView> = {}): EventView {
  return { index: 0, atMs, kind, label, ...extra };
}

describe("buildReproSteps", () => {
  it("merges consecutive same-direction scrolls and sums their deltas", () => {
    const steps = buildReproSteps([
      ev("scroll", 1000, "down 100px"),
      ev("scroll", 1400, "down 250px"),
      ev("scroll", 1800, "down 90px"),
    ]);
    expect(steps).toEqual([{ atMs: 1000, kind: "scroll", label: "440px", detail: "down" }]);
  });

  it("splits scroll groups on direction change and on large gaps", () => {
    const steps = buildReproSteps([
      ev("scroll", 1000, "down 100px"),
      ev("scroll", 1500, "up 60px"),
      ev("scroll", 10_000, "down 50px"),
    ]);
    expect(steps).toHaveLength(3);
    expect(steps[0]).toMatchObject({ kind: "scroll", detail: "down", label: "100px" });
    expect(steps[1]).toMatchObject({ kind: "scroll", detail: "up", label: "60px" });
    expect(steps[2]).toMatchObject({ kind: "scroll", detail: "down", label: "50px" });
  });

  it("joins keystrokes into one step and keeps named keys in braces", () => {
    const steps = buildReproSteps([
      ev("key", 2000, "h"),
      ev("key", 2100, "i"),
      ev("key", 2200, "Enter"),
    ]);
    expect(steps).toEqual([{ atMs: 2000, kind: "key", label: "hi{Enter}" }]);
  });

  it("folds a focus on the same control into the typed step's detail", () => {
    const steps = buildReproSteps([
      ev("focus", 1900, "input#coupon", { selector: "input#coupon" }),
      ev("key", 2000, "s", { selector: "input#coupon" }),
      ev("key", 2100, "a", { selector: "input#coupon" }),
    ]);
    expect(steps).toEqual([{ atMs: 2000, kind: "key", label: "sa", detail: "input#coupon" }]);
  });

  it("keeps a lone focus as its own step", () => {
    const steps = buildReproSteps([
      ev("focus", 1900, "input#email", { selector: "input#email" }),
      ev("click", 5000, "Submit"),
    ]);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ kind: "focus", label: "input#email" });
  });

  it("dedupes rapid navigations to the same URL", () => {
    const steps = buildReproSteps([
      ev("navigation", 0, "https://a.test/p"),
      ev("navigation", 800, "https://a.test/p"),
      ev("navigation", 5000, "https://a.test/q"),
    ]);
    expect(steps.map((s) => s.label)).toEqual(["https://a.test/p", "https://a.test/q"]);
  });

  it("passes clicks, contextmenus, and submits through one-to-one", () => {
    const steps = buildReproSteps([
      ev("click", 100, "Apply coupon"),
      ev("contextmenu", 200, "Avatar"),
      ev("submit", 300, "form#checkout"),
    ]);
    expect(steps).toHaveLength(3);
    expect(steps.map((s) => s.kind)).toEqual(["click", "contextmenu", "submit"]);
  });

  it("respects the step limit", () => {
    const many = Array.from({ length: 50 }, (_, i) => ev("click", i * 1000, `btn${i}`));
    expect(buildReproSteps(many, { limit: 10 })).toHaveLength(10);
  });

  it("is deterministic", () => {
    const events = [
      ev("navigation", 0, "https://a.test/"),
      ev("scroll", 100, "down 10px"),
      ev("scroll", 300, "down 20px"),
      ev("key", 1000, "x"),
      ev("click", 2000, "Go"),
    ];
    expect(JSON.stringify(buildReproSteps(events))).toBe(JSON.stringify(buildReproSteps(events)));
  });
});

describe("formatReproStep", () => {
  it("renders each kind as an English one-liner", () => {
    const cases: Array<[ReproStep, string]> = [
      [{ atMs: 0, kind: "navigation", label: "https://a.test/" }, "Opened https://a.test/"],
      [{ atMs: 0, kind: "click", label: "Apply" }, 'Clicked "Apply"'],
      [{ atMs: 0, kind: "contextmenu", label: "Img" }, 'Right-clicked "Img"'],
      [{ atMs: 0, kind: "scroll", label: "440px", detail: "down" }, "Scrolled down 440px"],
      [{ atMs: 0, kind: "key", label: "hi{Enter}" }, 'Typed "hi{Enter}"'],
      [{ atMs: 0, kind: "key", label: "{Enter}" }, "Pressed Enter"],
      [{ atMs: 0, kind: "key", label: "abc", detail: "#email" }, 'Typed "abc" into "#email"'],
      [{ atMs: 0, kind: "submit", label: "#form" }, "Submitted #form"],
      [{ atMs: 0, kind: "focus", label: "#x" }, 'Focused "#x"'],
    ];
    for (const [step, expected] of cases) {
      expect(formatReproStep(step)).toBe(expected);
    }
  });
});
