/**
 * Real unit tests for shipped `diffStorageGroups` / `toStorageItems`.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { diffStorageGroups, toStorageItems } from "./storage-diff";

describe("diffStorageGroups", () => {
  it("classifies added / removed / changed / unchanged keys", () => {
    const start = [
      { key: "stay", value: "same" },
      { key: "mutate", value: "before" },
      { key: "gone", value: "old" },
    ];
    const stop = [
      { key: "stay", value: "same" },
      { key: "mutate", value: "after" },
      { key: "fresh", value: "new" },
    ];

    const rows = diffStorageGroups(start, stop);
    const byKey = new Map(rows.map((r) => [r.key, r]));

    expect(byKey.get("stay")).toEqual({ key: "stay", status: "unchanged", value: "same" });
    expect(byKey.get("mutate")).toEqual({
      key: "mutate",
      status: "changed",
      from: "before",
      to: "after",
    });
    expect(byKey.get("gone")).toEqual({ key: "gone", status: "removed", value: "old" });
    expect(byKey.get("fresh")).toEqual({ key: "fresh", status: "added", value: "new" });
  });

  it("returns no rows when both snapshots are empty", () => {
    expect(diffStorageGroups([], [])).toEqual([]);
  });

  it("produces exactly one diff row for each key in start∪stop", () => {
    const itemArb = fc.record({
      key: fc.constantFrom("a", "b", "c", "d", "e", "f"),
      value: fc.string(),
    });
    const itemsArb = fc.array(itemArb, { maxLength: 12 });

    fc.assert(
      fc.property(itemsArb, itemsArb, (start, stop) => {
        // Collapse duplicate keys like Maps do (last write wins).
        const startMap = new Map(start.map((it) => [it.key, it.value]));
        const stopMap = new Map(stop.map((it) => [it.key, it.value]));
        const startNorm = [...startMap].map(([key, value]) => ({ key, value }));
        const stopNorm = [...stopMap].map(([key, value]) => ({ key, value }));
        const rows = diffStorageGroups(startNorm, stopNorm);
        const union = new Set([...startMap.keys(), ...stopMap.keys()]);
        expect(rows).toHaveLength(union.size);
        expect(new Set(rows.map((r) => r.key)).size).toBe(union.size);
      }),
    );
  });
});

describe("toStorageItems", () => {
  it("maps localStorage-style key/value pairs", () => {
    expect(
      toStorageItems(
        {
          localStorage: [
            { key: "a", value: "1" },
            { key: "b", value: "2" },
          ],
        },
        "localStorage",
      ),
    ).toEqual([
      { key: "a", value: "1" },
      { key: "b", value: "2" },
    ]);
  });

  it("maps cookies by name", () => {
    expect(toStorageItems({ cookies: [{ name: "sid", value: "x" }] }, "cookies")).toEqual([
      { key: "sid", value: "x" },
    ]);
  });
});
