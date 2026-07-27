/**
 * User-event capture for the in-page SDK.
 *
 * Emits the `RecordingUserEvent` union the extension's content script produces,
 * so the player's timeline renders an SDK recording identically. The listener
 * wiring is the SDK's own because the extension's is built around a
 * `chrome.runtime` transport and a drawing overlay the SDK has no equivalent
 * of — but the schema and the keyboard privacy policy are shared, and those are
 * the parts that must not diverge.
 *
 * Two deliberate omissions: element text is never read, and printable
 * keystrokes are dropped by `formatKeyLabel`. An SDK is embedded in a real
 * product, so anything it records by default is recorded from real users.
 */

import { formatKeyLabel } from "../../replay-core/src/capture/key-event";
import type { RecordingUserEvent } from "../../replay-core/src/schema/capture";

export type UserEventSink = (event: RecordingUserEvent) => void;

export interface UserEventCaptureOptions {
  /** CSS selectors whose elements must not be identified in the timeline. */
  maskSelectors?: string[];
}

/** Longest selector this builds before falling back to what it has. */
const MAX_SELECTOR_DEPTH = 4;

/** Scroll deltas below this are noise from momentum and rubber-banding. */
const MIN_SCROLL_DELTA_PX = 24;

const SENSITIVE_INPUT_TYPES = new Set(["password", "email", "tel"]);
const FORM_CONTROL_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * A stable-ish CSS selector for an element. Best effort by design: the selector
 * is a human hint in the timeline, not something anything replays against.
 */
export function describeElement(element: Element): string {
  if (element.id) {
    return `#${element.id}`;
  }

  const parts: string[] = [];
  let current: Element | null = element;
  let depth = 0;

  while (current && depth < MAX_SELECTOR_DEPTH) {
    if (current.id) {
      parts.unshift(`#${current.id}`);
      break;
    }
    let part = current.tagName.toLowerCase();
    const className = typeof current.className === "string" ? current.className.trim() : "";
    const first = className ? className.split(/\s+/)[0] : "";
    if (first) {
      part += `.${first}`;
    }
    parts.unshift(part);
    current = current.parentElement;
    depth += 1;
  }

  return parts.join(" > ");
}

function isMasked(element: Element, maskSelectors: string[]): boolean {
  for (const selector of maskSelectors) {
    try {
      if (element.closest(selector)) {
        return true;
      }
    } catch {
      // An invalid selector must never break capture; skip it.
    }
  }
  return false;
}

function isSensitiveTarget(element: Element | null): boolean {
  if (!element) {
    return false;
  }
  const type = element.getAttribute("type");
  if (type && SENSITIVE_INPUT_TYPES.has(type.toLowerCase())) {
    return true;
  }
  return element.getAttribute("autocomplete")?.includes("password") === true;
}

/**
 * Attaches listeners and returns a cleanup function that removes every one of
 * them, mirroring `installInPageCapture` so a session tears both down the same
 * way.
 */
export function installUserEventCapture(
  target: Window,
  sink: UserEventSink,
  options: UserEventCaptureOptions = {},
): () => void {
  const maskSelectors = options.maskSelectors ?? [];
  const removers: Array<() => void> = [];
  let lastScrollY = target.scrollY;

  const elementOf = (node: EventTarget | null): Element | null =>
    node instanceof Element ? node : null;

  const describe = (node: EventTarget | null): string | undefined => {
    const element = elementOf(node);
    if (!element) {
      return undefined;
    }
    return isMasked(element, maskSelectors) ? "[masked]" : describeElement(element);
  };

  const viewport = (): { viewportWidth: number; viewportHeight: number } => ({
    viewportWidth: target.innerWidth,
    viewportHeight: target.innerHeight,
  });

  const on = <K extends keyof WindowEventMap>(
    type: K,
    handler: (event: WindowEventMap[K]) => void,
  ): void => {
    const listener = handler as EventListener;
    target.addEventListener(type, listener, { capture: true, passive: true });
    removers.push(() => target.removeEventListener(type, listener, { capture: true }));
  };

  on("click", (event) => {
    sink({
      type: "click",
      timestamp: Date.now(),
      selector: describe(event.target),
      x: event.clientX,
      y: event.clientY,
      ...viewport(),
    });
  });

  on("contextmenu", (event) => {
    sink({
      type: "contextmenu",
      timestamp: Date.now(),
      selector: describe(event.target),
      x: event.clientX,
      y: event.clientY,
      ...viewport(),
    });
  });

  on("scroll", () => {
    const deltaY = target.scrollY - lastScrollY;
    if (Math.abs(deltaY) < MIN_SCROLL_DELTA_PX) {
      return;
    }
    lastScrollY = target.scrollY;
    sink({
      type: "scroll",
      timestamp: Date.now(),
      direction: deltaY > 0 ? "down" : "up",
      deltaY,
      y: target.scrollY,
      ...viewport(),
    });
  });

  on("focusin", (event) => {
    const element = elementOf(event.target);
    if (!element || !FORM_CONTROL_TAGS.has(element.tagName)) {
      return;
    }
    sink({
      type: "focus",
      timestamp: Date.now(),
      selector: describe(event.target),
      inputType: element.getAttribute("type") ?? element.tagName.toLowerCase(),
    });
  });

  on("submit", (event) => {
    sink({ type: "submit", timestamp: Date.now(), selector: describe(event.target) });
  });

  on("keydown", (event) => {
    const element = elementOf(event.target);
    // Shared allowlist: named keys and modifier chords only, never typed text.
    const label = formatKeyLabel(event, {
      isFormControl: element ? FORM_CONTROL_TAGS.has(element.tagName) : false,
      isSensitive: isSensitiveTarget(element),
    });
    if (!label) {
      return;
    }
    sink({
      type: "key",
      timestamp: Date.now(),
      key: label,
      code: event.code,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
      selector: describe(event.target),
    });
  });

  // SPA route changes: `popstate` covers back/forward, and patching the history
  // methods covers push/replace, which fire no event of their own.
  const emitNavigation = (): void => {
    sink({
      type: "navigation",
      timestamp: Date.now(),
      url: target.location.href,
      title: target.document?.title,
    });
  };

  on("popstate", emitNavigation);
  removers.push(patchHistory(target, emitNavigation));

  return () => {
    while (removers.length > 0) {
      removers.pop()?.();
    }
  };
}

/**
 * Wraps `pushState`/`replaceState` so client-side routing shows on the
 * timeline. Returns a restorer that puts back the exact original references.
 */
function patchHistory(target: Window, onNavigate: () => void): () => void {
  const history = target.history;
  if (!history) {
    return () => {};
  }

  const originalPush = history.pushState;
  const originalReplace = history.replaceState;

  history.pushState = function patchedPushState(this: History, ...args) {
    const result = originalPush.apply(this, args);
    onNavigate();
    return result;
  };
  history.replaceState = function patchedReplaceState(this: History, ...args) {
    const result = originalReplace.apply(this, args);
    onNavigate();
    return result;
  };

  return () => {
    history.pushState = originalPush;
    history.replaceState = originalReplace;
  };
}
