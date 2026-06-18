/**
 * Property-based tests for the in-memory Chrome storage mock.
 *
 * Property 8: Mock storage round-trip — after `set({[k]: v})`, `get(k)` resolves
 * to `{[k]: v}`; keys that are removed, cleared, or never set are absent from
 * subsequent reads.
 *
 * **Validates: Requirements 4.5, 4.8**
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createChromeMock } from "./chrome";

/**
 * Arbitrary for JSON-serializable values, exercising the kinds of payloads the
 * extension actually stores (primitives, arrays, nested records).
 */
const jsonValue: fc.Arbitrary<unknown> = fc.jsonValue();

/** Arbitrary for arbitrary string storage keys, including empty/unicode keys. */
const storageKey: fc.Arbitrary<string> = fc.string();

describe("MockStorageArea round-trip (Property 8)", () => {
  it("resolves {[k]: v} after set({[k]: v}) for a fresh storage area", async () => {
    await fc.assert(
      fc.asyncProperty(storageKey, jsonValue, async (k, v) => {
        const { storage } = createChromeMock();
        await storage.session.set({ [k]: v });
        const result = await storage.session.get(k);
        expect(result).toEqual({ [k]: v });
      }),
    );
  });

  it("resolves {} for a key that was never set", async () => {
    await fc.assert(
      fc.asyncProperty(storageKey, async (k) => {
        const { storage } = createChromeMock();
        const result = await storage.session.get(k);
        expect(result).toEqual({});
      }),
    );
  });

  it("omits a key from subsequent reads after remove(k)", async () => {
    await fc.assert(
      fc.asyncProperty(storageKey, jsonValue, async (k, v) => {
        const { storage } = createChromeMock();
        await storage.session.set({ [k]: v });
        await storage.session.remove(k);
        const result = await storage.session.get(k);
        expect(result).toEqual({});
      }),
    );
  });

  it("resolves {} for all keys after clear()", async () => {
    await fc.assert(
      fc.asyncProperty(fc.dictionary(storageKey, jsonValue, { minKeys: 1 }), async (items) => {
        const { storage } = createChromeMock();
        await storage.session.set(items);
        await storage.session.clear();
        // Reading any previously set key, or the whole store, yields nothing.
        const all = await storage.session.get();
        expect(all).toEqual({});
        for (const key of Object.keys(items)) {
          const single = await storage.session.get(key);
          expect(single).toEqual({});
        }
      }),
    );
  });

  it("round-trips independently across session and local areas", async () => {
    await fc.assert(
      fc.asyncProperty(storageKey, jsonValue, jsonValue, async (k, sessionVal, localVal) => {
        const { storage } = createChromeMock();
        await storage.session.set({ [k]: sessionVal });
        await storage.local.set({ [k]: localVal });
        expect(await storage.session.get(k)).toEqual({ [k]: sessionVal });
        expect(await storage.local.get(k)).toEqual({ [k]: localVal });
      }),
    );
  });
});
