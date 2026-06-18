/**
 * Property-based tests for the pure recording target-tab validation.
 *
 * These tests target {@link getRecordingTabTarget}, a Chrome-API-free function
 * that decides whether a tab can be recorded. Because it is pure, its totality
 * invariant can be checked across a wide range of generated tab-like inputs.
 *
 * fast-check and Vitest are added as dev dependencies in a later task (task 9),
 * so the imports below may surface a resolution warning until then. The global
 * fast-check configuration (numRuns, verbose, seed reporting) is applied via
 * the `test/property-config.ts` setup file.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { makeTab } from "../../test/factories";
import { getRecordingTabTarget, type RecordingTabLike } from "./recording-target";

describe("getRecordingTabTarget", () => {
  /**
   * Generator for a wide range of URL-like strings, including:
   *  - well-formed web URLs (`fc.webUrl()`),
   *  - browser/system/internal schemes (chrome://, edge://, about:, data:,
   *    blob:, chrome-extension://, devtools://, file:),
   *  - Chrome Web Store URLs,
   *  - empty strings, and
   *  - arbitrary free-form strings that may or may not parse as URLs.
   */
  const urlArbitrary = fc.oneof(
    fc.webUrl(),
    fc.constantFrom(
      "",
      "chrome://settings",
      "chrome://extensions/",
      "edge://settings",
      "about:blank",
      "data:text/html,<p>hi</p>",
      "blob:https://example.com/abc",
      "chrome-extension://abcdef/page.html",
      "devtools://devtools/bundled/inspector.html",
      "file:///Users/test/index.html",
      "https://chromewebstore.google.com/detail/foo",
      "https://chrome.google.com/webstore/detail/bar",
      "https://example.com/",
      "not a url at all",
      "://missing-scheme",
      "ftp://example.com/resource",
    ),
    fc.string(),
  );

  /**
   * Generator for {@link RecordingTabLike} inputs with varied or absent ids and
   * arbitrary url/pendingUrl fields. Each field is independently optional so
   * the generator covers tabs with missing ids, non-numeric absence, and tabs
   * that only expose a `pendingUrl`.
   */
  const tabArbitrary: fc.Arbitrary<RecordingTabLike> = fc.record(
    {
      id: fc.option(fc.integer(), { nil: undefined }),
      url: fc.option(urlArbitrary, { nil: undefined }),
      pendingUrl: fc.option(urlArbitrary, { nil: undefined }),
    },
    { requiredKeys: [] },
  );

  /**
   * Property 5: Target validation totality.
   *
   * For every tab-like input, `getRecordingTabTarget` returns a result in which
   * exactly one of `url`/`error` is non-null. The function is total: it always
   * yields a definite outcome (a recordable URL or a user-facing error), never
   * both and never neither.
   *
   * **Validates: Requirements 5.6**
   */
  it("returns exactly one non-null field of url/error (Property 5: target validation totality)", () => {
    fc.assert(
      fc.property(
        // Include the null/undefined tab cases alongside generated tab records.
        fc.option(tabArbitrary, { nil: undefined, freq: 5 }),
        (tab) => {
          const result = getRecordingTabTarget(tab);
          // XOR: exactly one of url/error is non-null.
          expect((result.url == null) !== (result.error == null)).toBe(true);
        },
      ),
    );
  });

  it("returns exactly one non-null field for factory-built tabs (Property 5: target validation totality)", () => {
    fc.assert(
      fc.property(
        fc.record(
          {
            id: fc.option(fc.integer(), { nil: undefined }),
            url: fc.option(urlArbitrary, { nil: undefined }),
            pendingUrl: fc.option(urlArbitrary, { nil: undefined }),
          },
          { requiredKeys: [] },
        ),
        (overrides) => {
          const result = getRecordingTabTarget(makeTab(overrides));
          expect((result.url == null) !== (result.error == null)).toBe(true);
        },
      ),
    );
  });

  /**
   * Property 6: Target validation soundness.
   *
   * Whenever `getRecordingTabTarget` accepts a tab (returns a non-null `url`),
   * that URL must be safe to record: it must use one of the recordable
   * protocols (`http:`, `https:`, `file:`) and must not point at a Chrome Web
   * Store host. This guards against the validator ever green-lighting a page it
   * is meant to reject.
   *
   * **Validates: Requirements 5.7**
   */
  it("only accepts http/https/file URLs on non–Chrome Web Store hosts (Property 6: target validation soundness)", () => {
    const isChromeWebStoreHost = (parsed: URL): boolean =>
      parsed.hostname === "chromewebstore.google.com" ||
      (parsed.hostname === "chrome.google.com" && parsed.pathname.startsWith("/webstore"));

    fc.assert(
      fc.property(fc.option(tabArbitrary, { nil: undefined, freq: 5 }), (tab) => {
        const result = getRecordingTabTarget(tab);
        if (result.url == null) {
          return; // Rejected inputs carry no soundness obligation.
        }
        // Accepted URLs must parse and satisfy the protocol/host constraints.
        const parsed = new URL(result.url);
        expect(["http:", "https:", "file:"]).toContain(parsed.protocol);
        expect(isChromeWebStoreHost(parsed)).toBe(false);
      }),
    );
  });
});
