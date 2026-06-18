/**
 * Property-based tests for the pure privacy/redaction policy.
 *
 * These tests target {@link redactHeaderMap} and the wider redaction policy,
 * which are deliberately implemented without Chrome API dependencies so the
 * invariants can be checked across a wide range of generated inputs.
 *
 * fast-check and Vitest are added as dev dependencies in a later task (task 9),
 * so the imports below may surface a resolution warning until then. The global
 * fast-check configuration (numRuns, verbose, seed reporting) is applied via
 * the `test/property-config.ts` setup file.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { makeHeaderMap, makePrivacySettings } from "../../test/factories";
import {
  getEnabledRedactionRuleIds,
  normalizeMaskDomSelectors,
  REDACTED_VALUE,
  REDACTION_RULE_TARGETS,
  redactHeaderMap,
  redactJsonValue,
} from "./privacy-redaction";

describe("redactHeaderMap", () => {
  // Header keys that have an enabled credential redaction rule under both the
  // `standard` and `strict` profiles.
  const sensitiveHeaderKeys = ["authorization", "cookie", "x-api-key"] as const;

  // Benign values retained verbatim by the factory's default header map. A
  // generated "secret" equal to one of these would match an output value
  // without being an actual leak, so they are excluded from the generator.
  const benignValues = new Set([REDACTED_VALUE, ...Object.values(makeHeaderMap())]);

  /**
   * Property 1: Redaction never leaks secrets.
   *
   * For an enabled header rule, no output header value is an exact,
   * case-sensitive string match to the original sensitive value placed under
   * that key.
   *
   * **Validates: Requirements 5.2**
   */
  it("never emits a raw sensitive header value (Property 1: redaction never leaks secrets)", () => {
    fc.assert(
      fc.property(
        // A non-empty secret value. Exclude values the factory retains
        // verbatim (and the redaction marker), which would match an output
        // value without representing a leak of the secret under test.
        fc.string({ minLength: 1 }).filter((secret) => !benignValues.has(secret)),
        fc.constantFrom(...sensitiveHeaderKeys),
        fc.constantFrom("standard" as const, "strict" as const),
        (secret, headerKey, profile) => {
          const settings = makePrivacySettings(profile);
          // Place the secret under a header key that has an enabled redaction
          // rule, alongside the factory's benign defaults.
          const headers = makeHeaderMap({ [headerKey]: secret });

          const { value } = redactHeaderMap(headers, settings);

          // The sensitive key must be present and redacted.
          expect(value).not.toBeNull();
          expect(value?.[headerKey]).toBe(REDACTED_VALUE);

          // The secret must not survive verbatim in ANY output header value.
          expect(Object.values(value ?? {})).not.toContain(secret);
        },
      ),
    );
  });
});

describe("redactHeaderMap idempotence", () => {
  // Header keys with an enabled credential redaction rule under both profiles.
  const sensitiveHeaderKeys = ["authorization", "cookie", "x-api-key"] as const;

  /**
   * Property 2: Redaction is idempotent.
   *
   * Applying the redaction policy to its own output produces a result deeply
   * equal to the single-application result: `redact(redact(x)) = redact(x)`.
   * The exported policy entry point exercised here is {@link redactHeaderMap};
   * the wider `redactJsonValue` walk is not exported, so the header policy
   * stands in as the testable surface for this invariant.
   *
   * **Validates: Requirements 5.3**
   */
  it("re-redacting already-redacted headers yields no further change (Property 2: redaction is idempotent)", () => {
    fc.assert(
      fc.property(
        // Arbitrary values for the sensitive header keys.
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        // Arbitrary extra (potentially sensitive or benign) header entries.
        fc.dictionary(fc.string({ minLength: 1 }), fc.string()),
        fc.constantFrom("standard" as const, "strict" as const),
        (auth, cookie, apiKey, extraHeaders, profile) => {
          const settings = makePrivacySettings(profile);
          const headers = makeHeaderMap({
            ...extraHeaders,
            [sensitiveHeaderKeys[0]]: auth,
            [sensitiveHeaderKeys[1]]: cookie,
            [sensitiveHeaderKeys[2]]: apiKey,
          });

          const once = redactHeaderMap(headers, settings).value;
          const twice = redactHeaderMap(once, settings).value;

          // Applying redaction a second time changes nothing.
          expect(twice).toEqual(once);
        },
      ),
    );
  });
});

describe("redactJsonValue structure preservation", () => {
  /**
   * Recursively assert that `redacted` has the IDENTICAL nesting structure as
   * `original`: every object has the same key set, every array has the same
   * length, and every position that is a container in the original is a
   * container of the same kind in the output. Leaf (scalar) values may change
   * — only their shape category (leaf vs object vs array) must be preserved.
   */
  const assertSameStructure = (original: unknown, redacted: unknown, path = "$"): void => {
    if (Array.isArray(original)) {
      // Arrays must stay arrays of the same length, recursing element-wise.
      expect(Array.isArray(redacted), `array shape preserved at ${path}`).toBe(true);
      const redactedArray = redacted as unknown[];
      expect(redactedArray.length, `array length preserved at ${path}`).toBe(original.length);
      original.forEach((item, index) => {
        assertSameStructure(item, redactedArray[index], `${path}[${index}]`);
      });
      return;
    }

    if (original !== null && typeof original === "object") {
      // Plain objects must stay objects with the identical key set.
      expect(
        redacted !== null && typeof redacted === "object" && !Array.isArray(redacted),
        `object shape preserved at ${path}`,
      ).toBe(true);
      const originalKeys = Object.keys(original as Record<string, unknown>).sort();
      const redactedKeys = Object.keys(redacted as Record<string, unknown>).sort();
      expect(redactedKeys, `key set preserved at ${path}`).toEqual(originalKeys);
      for (const key of originalKeys) {
        assertSameStructure(
          (original as Record<string, unknown>)[key],
          (redacted as Record<string, unknown>)[key],
          `${path}.${key}`,
        );
      }
      return;
    }

    // Leaf/scalar: the value may be replaced, but it must remain a scalar
    // (never promoted into an object or array).
    expect(
      redacted === null || (typeof redacted !== "object" && !Array.isArray(redacted)),
      `leaf remained a scalar at ${path}`,
    ).toBe(true);
  };

  /**
   * Property 3: Redaction preserves structure.
   *
   * For any JSON value, {@link redactJsonValue} preserves the complete key set
   * and nesting structure at every level, changing only leaf/scalar values.
   *
   * **Validates: Requirements 5.4**
   */
  it("preserves the key set and nesting of arbitrary JSON, changing only leaves (Property 3: redaction preserves structure)", () => {
    // Object keys are drawn from a curated set of NON-sensitive identifiers.
    // This is deliberate: when a key matches a sensitive rule (e.g. "token",
    // "cvc", "secret", "email"), `redactJsonValue` correctly collapses the
    // entire subtree under that key to the `REDACTED_VALUE` scalar — that is
    // the redaction policy working as intended, not a structure-preservation
    // violation. Special keys like `__proto__` are likewise excluded because
    // they are not own-enumerable in a plainly rebuilt object. Restricting the
    // key space to ordinary identifiers keeps this property focused on its real
    // invariant: for normally-keyed JSON, redaction changes only leaf values
    // and preserves the key set and nesting at every level.
    const safeKey = fc.constantFrom(
      "alpha",
      "beta",
      "gamma",
      "delta",
      "epsilon",
      "items",
      "list",
      "data",
      "node",
      "child",
      "count",
      "label",
      "group",
      "entry",
      "field",
      "row",
      "col",
      "first",
      "second",
      "third",
      "outer",
      "inner",
      "value",
      "total",
    );

    // JSON leaf values. Strings may be rewritten by value rules but must remain
    // scalars; numbers, booleans, and null pass through unchanged.
    const leaf = fc.oneof(
      fc.string(),
      fc.integer(),
      fc.double({ noNaN: true, noDefaultInfinity: true }),
      fc.boolean(),
      fc.constant(null),
    );

    // Recursive JSON-like generator with bounded nesting and non-sensitive keys.
    const { jsonLike } = fc.letrec((tie) => ({
      jsonLike: fc.oneof(
        { maxDepth: 4 },
        leaf,
        fc.array(tie("jsonLike"), { maxLength: 5 }),
        fc.dictionary(safeKey, tie("jsonLike"), { maxKeys: 5 }),
      ),
    }));

    fc.assert(
      fc.property(
        jsonLike,
        fc.constantFrom("standard" as const, "strict" as const),
        (json, profile) => {
          const settings = makePrivacySettings(profile);
          const { value } = redactJsonValue(json, settings, "body", "body", "body");
          assertSameStructure(json, value);
        },
      ),
    );
  });
});

describe("redaction profile monotonicity", () => {
  /**
   * Property 4: Profile monotonicity.
   *
   * The set of redaction rules enabled under the `strict` profile is a superset
   * of the set enabled under the `standard` profile, for every rule target.
   * Equivalently: anything `standard` redacts, `strict` also redacts.
   *
   * The internal rule tables and the `isRuleEnabled` predicate are not
   * exported, so the policy exposes {@link getEnabledRedactionRuleIds} — a
   * behavior-preserving introspection helper returning the enabled rule-id set
   * per profile + target. The property checks `strict ⊇ standard` directly for
   * a generated target.
   *
   * **Validates: Requirements 5.5**
   */
  it("enables under strict every rule enabled under standard (Property 4: profile monotonicity)", () => {
    fc.assert(
      fc.property(fc.constantFrom(...REDACTION_RULE_TARGETS), (target) => {
        const standardRules = getEnabledRedactionRuleIds("standard", target);
        const strictRules = getEnabledRedactionRuleIds("strict", target);

        // Every rule enabled under `standard` must also be enabled under
        // `strict` for this target.
        for (const ruleId of standardRules) {
          expect(strictRules.has(ruleId)).toBe(true);
        }
      }),
    );
  });

  /**
   * Stronger restatement of Property 4 across ALL targets simultaneously: the
   * union of strict-enabled rule ids is a superset of the union of
   * standard-enabled rule ids. This guards against a target where standard
   * enables a rule that strict omits.
   *
   * **Validates: Requirements 5.5**
   */
  it("strict's enabled rule-id set is a superset of standard's across every target", () => {
    const collect = (profile: "standard" | "strict"): Set<string> => {
      const all = new Set<string>();
      for (const target of REDACTION_RULE_TARGETS) {
        for (const ruleId of getEnabledRedactionRuleIds(profile, target)) {
          all.add(ruleId);
        }
      }
      return all;
    };

    const standardAll = collect("standard");
    const strictAll = collect("strict");

    for (const ruleId of standardAll) {
      expect(strictAll.has(ruleId)).toBe(true);
    }
  });
});

describe("normalizeMaskDomSelectors stability", () => {
  /**
   * Property 7: Selector normalization stability.
   *
   * {@link normalizeMaskDomSelectors} is idempotent: applying it to its own
   * output yields a result deeply equal to the single-application result, i.e.
   * `normalize(normalize(x)) = normalize(x)`. The single application already
   * splits/trims, drops empties, deduplicates, discards over-180-character
   * items, and caps the list at 50, so the output is a clean `string[]` — which
   * is itself a valid input — and a second pass must leave it unchanged.
   *
   * The generator deliberately spans the full input space the normalizer
   * accepts: arbitrary `string[]`, newline/comma-joined strings, mixed arrays
   * carrying non-string members (`fc.anything()`), whitespace-padded entries,
   * duplicates, over-long (>180 char) strings, and large (>50 entry) lists.
   *
   * **Validates: Requirements 5.8**
   */
  it("re-normalizing already-normalized selectors yields no further change (Property 7: selector normalization stability)", () => {
    // An entry likely to require trimming, deduplication, length-capping, or
    // type filtering, so generated inputs exercise every normalization branch.
    const messySelectorEntry = fc.oneof(
      fc.string(),
      // Whitespace-padded selectors (exercises trimming).
      fc.string().map((s) => `  ${s}  `),
      // Over-180-character selectors (exercises the length cap / drop).
      fc.string({ minLength: 181, maxLength: 400 }),
      // Empty / whitespace-only selectors (exercises empty drop).
      fc.constantFrom("", "   ", "\t", "\n"),
      // Arbitrary non-string members (exercises the type filter).
      fc.anything(),
    );

    const inputArbitrary = fc.oneof(
      // Arrays of arbitrary / messy selector entries, including large (>50)
      // lists and duplicates.
      fc.array(messySelectorEntry, { maxLength: 120 }),
      // Newline/comma-joined strings split apart by the normalizer. The
      // separator is drawn from the property's own seed for reproducibility.
      fc
        .tuple(fc.array(fc.string(), { maxLength: 120 }), fc.constantFrom("\n", ",", "\r\n"))
        .map(([parts, separator]) => parts.join(separator)),
      // Fully arbitrary values (non-string, non-array inputs normalize to []).
      fc.anything(),
    );

    fc.assert(
      fc.property(inputArbitrary, (input) => {
        const once = normalizeMaskDomSelectors(input);
        // The single-application output is a string[] and a valid input itself.
        const twice = normalizeMaskDomSelectors(once);
        expect(twice).toEqual(once);
      }),
    );
  });
});
