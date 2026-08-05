/**
 * Does the MAIN-world capture actually live in the page's realm?
 *
 * WHY THIS EXISTS: `scripting.executeScript({ world: "MAIN" })` can resolve with
 * no error while the script did not end up in the page realm at all. Two real
 * ways that happens on Firefox:
 *
 *   1. Firefox only supports the MAIN world from version 128. On 115-127 the
 *      injection lands in the isolated content-script sandbox instead.
 *   2. Unlike Chrome, a Firefox MAIN-world injection is subject to the PAGE's
 *      CSP, so a site with a strict `script-src` blocks it.
 *
 * In both cases the capture patches the *sandbox's* `console` and `fetch`, the
 * page's own globals stay untouched, and the recording finishes with completely
 * empty console/network evidence and no error anywhere. That is the worst
 * possible failure: silent and total.
 *
 * Inspecting `InjectionResult.error` cannot see it, because the script really did
 * run — just in the wrong realm. The only reliable check is to look for a
 * sentinel on the PAGE's global from the isolated world, which Firefox allows
 * through the Xray wrapper `window.wrappedJSObject`.
 */

import { IN_PAGE_CAPTURE_REALM_SENTINEL } from "./in-page-capture-bridge";

export type RealmProbeResult =
  /** The sentinel is visible on the page global: capture is genuinely live. */
  | { live: true }
  /** Xray is available and the sentinel is absent: the MAIN script is not in the page. */
  | { live: false; reason: string }
  /**
   * No Xray wrapper, so the realm cannot be inspected. Chromium behaves this
   * way and its MAIN world is reliable, so this must not be treated as failure.
   */
  | { live: "unknown"; reason: string };

/** The isolated-world global, narrowed to the bits the probe needs. */
export type IsolatedScope = {
  wrappedJSObject?: Record<string, unknown>;
};

/**
 * Read the page realm's sentinel from an isolated-world scope.
 *
 * Kept pure and scope-injected so the realm split can be tested without a
 * browser: pass a scope whose `wrappedJSObject` is a different object than the
 * scope itself, which is exactly the shape of the bug.
 */
export function probeMainWorldRealm(scope: IsolatedScope): RealmProbeResult {
  const pageGlobal = scope.wrappedJSObject;

  if (!pageGlobal) {
    return {
      live: "unknown",
      reason: "no Xray wrapper on this engine, so the page realm cannot be inspected",
    };
  }

  if (pageGlobal[IN_PAGE_CAPTURE_REALM_SENTINEL] === true) {
    return { live: true };
  }

  return {
    live: false,
    reason:
      "the MAIN-world capture script is not present in the page realm — Firefox needs " +
      "version 128+ for MAIN-world injection, and the page's Content-Security-Policy " +
      "can also block it",
  };
}

/** True when the probe positively proved the capture is not in the page realm. */
export function isRealmProbeFailure(result: RealmProbeResult): result is {
  live: false;
  reason: string;
} {
  return result.live === false;
}
