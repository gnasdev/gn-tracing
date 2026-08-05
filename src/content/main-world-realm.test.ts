/**
 * The realm split: MAIN-world capture that landed in the wrong global.
 *
 * WHY THIS EXISTS: `src/content/in-page-capture-pipeline.test.ts` wires the MAIN
 * and ISOLATED scripts to ONE shared window double, which is the right shape for
 * proving the protocol — and structurally blind to the worst real failure. If the
 * MAIN injection lands in the isolated content-script sandbox instead of the page
 * realm, both scripts still share a window, the protocol still works, and the
 * capture happily patches the sandbox's own `console` while the page's real
 * `console` is never touched. Nothing is captured and nothing errors.
 *
 * Two real causes: Firefox only supports `world: "MAIN"` from version 128, and a
 * Firefox MAIN-world injection is subject to the PAGE's CSP (unlike Chrome), so a
 * strict `script-src` blocks it.
 *
 * These tests model two DISTINCT globals with distinct consoles, so patching the
 * wrong one is observable.
 */

import { describe, expect, it } from "vitest";
import { IN_PAGE_CAPTURE_REALM_SENTINEL } from "../shared/in-page-capture-bridge";
import {
  type IsolatedScope,
  isRealmProbeFailure,
  probeMainWorldRealm,
} from "../shared/main-world-realm";

/** An isolated-world global whose Xray wrapper points at a separate page global. */
function isolatedScopeWithPage(pageGlobal: Record<string, unknown>): IsolatedScope {
  return { wrappedJSObject: pageGlobal };
}

describe("main-world realm probe", () => {
  it("reports live when the sentinel is on the page global", () => {
    const pageGlobal = { [IN_PAGE_CAPTURE_REALM_SENTINEL]: true };
    const result = probeMainWorldRealm(isolatedScopeWithPage(pageGlobal));

    expect(result.live).toBe(true);
    expect(isRealmProbeFailure(result)).toBe(false);
  });

  it("reports failure when the page global has no sentinel", () => {
    // This is the bug: MAIN ran, but in the sandbox — the page global is bare.
    const result = probeMainWorldRealm(isolatedScopeWithPage({}));

    expect(result.live).toBe(false);
    expect(isRealmProbeFailure(result)).toBe(true);
    if (result.live === false) {
      expect(result.reason).toMatch(/128/);
      expect(result.reason).toMatch(/Content-Security-Policy/i);
    }
  });

  it("is not fooled by the sentinel sitting on the isolated global only", () => {
    // The exact false positive a naive liveness ping would produce: the sandbox
    // has the flag, the page does not.
    const scope = {
      [IN_PAGE_CAPTURE_REALM_SENTINEL]: true,
      wrappedJSObject: {},
    } as unknown as IsolatedScope;

    expect(probeMainWorldRealm(scope).live).toBe(false);
  });

  it("returns unknown, not failure, on engines without an Xray wrapper", () => {
    // Chromium has no wrappedJSObject and its MAIN world is reliable. Treating
    // that as failure would break recording on every Chromium browser.
    const result = probeMainWorldRealm({});

    expect(result.live).toBe("unknown");
    expect(isRealmProbeFailure(result)).toBe(false);
  });

  it("rejects a non-true sentinel value", () => {
    // A page script could set an unrelated truthy property under that name;
    // only the exact boolean the MAIN script writes counts.
    for (const value of ["true", 1, {}, null, undefined]) {
      const result = probeMainWorldRealm(
        isolatedScopeWithPage({ [IN_PAGE_CAPTURE_REALM_SENTINEL]: value }),
      );
      expect(result.live).toBe(false);
    }
  });
});

describe("realm split makes wrong-world patching observable", () => {
  /**
   * A miniature of the real failure: capture patches whichever console its own
   * global exposes. When that global is the sandbox, the page's console is
   * untouched and no entry is ever produced.
   */
  it("patching the sandbox console leaves the page console unobserved", () => {
    const emitted: string[] = [];

    const pageConsole = { error: (message: string) => void message };
    const sandboxConsole = { error: (message: string) => void message };

    // Stand-in for installConsoleCapture, applied to the WRONG global.
    const original = sandboxConsole.error;
    sandboxConsole.error = (message: string) => {
      emitted.push(message);
      original(message);
    };

    // The page does what a page does.
    pageConsole.error("boom");

    // Nothing captured: exactly the reported symptom.
    expect(emitted).toEqual([]);

    // And with the patch on the right global, the same call is captured.
    const pageOriginal = pageConsole.error;
    pageConsole.error = (message: string) => {
      emitted.push(message);
      pageOriginal(message);
    };
    pageConsole.error("boom");
    expect(emitted).toEqual(["boom"]);
  });
});
