/**
 * Tests for Item 2 (Resources/Storage panel) — unit + property-based.
 *
 * Covers three Item-2 surfaces:
 *  - `diffStorageGroups` — the start↔stop diff used by the player Storage tab
 *    (Property P4 / R5.2: every key in start∪stop yields exactly one row).
 *  - Storage redaction via `redactJsonValue` with `artifact = "storage"` — the
 *    same primitive `CdpManager.#redactStorageItems` / `#redactCookies` use
 *    (P3 / R4.4: sensitive keys are replaced with `REDACTED_VALUE`).
 *  - `isUploadArtifactKey("storage")` — the upload pipeline guard (R2.2).
 *  - Round-trip serialize/parse of `StorageArtifact` (P4-round-trip / R2.5).
 *
 * `diffStorageGroups` lives inside the non-bundled player IIFE
 * (`player/player.js`, ~line 699) and is not importable. To meaningfully test
 * R5.2 / Property P4 without a build step for the player, the algorithm is
 * mirrored verbatim below. Keep `diffStorageGroups` here byte-for-byte in sync
 * with `player/player.js`.
 *
 * fast-check global config (numRuns, verbose, seed reporting) is applied via the
 * `test/property-config.ts` setup file.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { makePrivacySettings } from "../../test/factories";
import { isUploadArtifactKey } from "../background/upload-orchestrator";
import type { CookieRecord, StorageArtifact, StorageKeyValue } from "../types/recording";
import { REDACTED_VALUE, redactJsonValue } from "./privacy-redaction";

// ---------------------------------------------------------------------------
// Mirror of player/player.js `diffStorageGroups` (~line 699). Must stay in sync
// with the canonical implementation. Builds a one-row-per-key diff between two
// storage groups; every key present in start∪stop yields exactly one row.
// ---------------------------------------------------------------------------
type DiffRow =
  | { key: string; status: "added"; value: string }
  | { key: string; status: "removed"; value: string }
  | { key: string; status: "unchanged"; value: string }
  | { key: string; status: "changed"; from: string; to: string };

function diffStorageGroups(
  startItems: Array<{ key: string; value: string }>,
  stopItems: Array<{ key: string; value: string }>,
): DiffRow[] {
  const startMap = new Map((startItems || []).map((it) => [it.key, it.value]));
  const stopMap = new Map((stopItems || []).map((it) => [it.key, it.value]));
  const rows: DiffRow[] = [];
  for (const [key, value] of stopMap) {
    if (!startMap.has(key)) {
      rows.push({ key, status: "added", value });
    } else if (startMap.get(key) !== value) {
      rows.push({ key, status: "changed", from: startMap.get(key) as string, to: value });
    } else {
      rows.push({ key, status: "unchanged", value });
    }
  }
  for (const [key, value] of startMap) {
    if (!stopMap.has(key)) {
      rows.push({ key, status: "removed", value });
    }
  }
  return rows;
}

describe("diffStorageGroups (diff completeness, R5.2 / Property P4)", () => {
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

  it("marks every key added when only the stop snapshot has entries", () => {
    const rows = diffStorageGroups([], [{ key: "a", value: "1" }]);
    expect(rows).toEqual([{ key: "a", status: "added", value: "1" }]);
  });

  it("marks every key removed when only the start snapshot has entries", () => {
    const rows = diffStorageGroups([{ key: "a", value: "1" }], []);
    expect(rows).toEqual([{ key: "a", status: "removed", value: "1" }]);
  });

  /**
   * Property P4 (diff completeness): every key present in start∪stop yields
   * exactly one diff row — no key is dropped and none is duplicated.
   *
   * **Validates: Requirements 5.2**
   */
  it("produces exactly one diff row for each key in start∪stop", () => {
    const itemArb = fc.record({
      // Small key alphabet so collisions, additions, removals, and changes all
      // occur frequently across generated cases.
      key: fc.constantFrom("a", "b", "c", "d", "e", "f"),
      value: fc.string(),
    });
    const itemsArb = fc.array(itemArb, { maxLength: 12 });

    fc.assert(
      fc.property(itemsArb, itemsArb, (startItems, stopItems) => {
        const rows = diffStorageGroups(startItems, stopItems);

        // A Map dedupes colliding keys exactly as the implementation does, so
        // the expected key universe is the union of the two maps' key sets.
        const expectedKeys = new Set<string>([
          ...new Map(startItems.map((it) => [it.key, it.value])).keys(),
          ...new Map(stopItems.map((it) => [it.key, it.value])).keys(),
        ]);

        const rowKeys = rows.map((r) => r.key);

        // Exactly one row per key: row count equals the key-universe size and
        // there are no duplicate keys.
        expect(rowKeys.length).toBe(expectedKeys.size);
        expect(new Set(rowKeys).size).toBe(rowKeys.length);
        // The set of row keys is exactly the key universe.
        expect(new Set(rowKeys)).toEqual(expectedKeys);
      }),
    );
  });

  /**
   * Each diff row's status agrees with the underlying start/stop maps. This
   * pins the per-key semantics that R5.2 relies on.
   *
   * **Validates: Requirements 5.2**
   */
  it("assigns a status consistent with the start/stop values for every key", () => {
    const itemArb = fc.record({
      key: fc.constantFrom("a", "b", "c", "d"),
      value: fc.string(),
    });
    const itemsArb = fc.array(itemArb, { maxLength: 10 });

    fc.assert(
      fc.property(itemsArb, itemsArb, (startItems, stopItems) => {
        const startMap = new Map<string, string>(startItems.map((it) => [it.key, it.value]));
        const stopMap = new Map<string, string>(stopItems.map((it) => [it.key, it.value]));
        const rows = diffStorageGroups(startItems, stopItems);

        for (const row of rows) {
          const inStart = startMap.has(row.key);
          const inStop = stopMap.has(row.key);
          if (inStart && !inStop) {
            expect(row.status).toBe("removed");
          } else if (!inStart && inStop) {
            expect(row.status).toBe("added");
          } else if (startMap.get(row.key) === stopMap.get(row.key)) {
            expect(row.status).toBe("unchanged");
          } else {
            expect(row.status).toBe("changed");
          }
        }
      }),
    );
  });
});

describe("storage redaction via redactJsonValue (R4.4 / Property P3)", () => {
  // Mirror of CdpManager.#redactStorageItems: wrap the value in `{ [key]: value }`
  // so the shared policy classifies the storage key by name, with
  // artifact = "storage" and target = "body".
  const redactStorageValue = (
    key: string,
    value: string,
  ): { value: string; redacted?: boolean } => {
    const settings = makePrivacySettings("standard");
    const result = redactJsonValue(
      { [key]: value },
      settings,
      "storage",
      "storage.localStorage",
      "body",
    );
    const redactedValue = (result.value as Record<string, unknown>)[key];
    return {
      value: typeof redactedValue === "string" ? redactedValue : String(redactedValue),
      redacted: result.applied.length > 0 ? true : undefined,
    };
  };

  it("redacts values under credential-class keys and tags the artifact as storage", () => {
    for (const key of ["password", "token", "session", "apiKey", "authorization", "csrf"]) {
      const settings = makePrivacySettings("standard");
      const result = redactJsonValue(
        { [key]: "super-secret-value" },
        settings,
        "storage",
        "storage.localStorage",
        "body",
      );
      expect((result.value as Record<string, unknown>)[key]).toBe(REDACTED_VALUE);
      expect(result.applied.length).toBeGreaterThan(0);
      expect(result.applied.every((hit) => hit.artifact === "storage")).toBe(true);
    }
  });

  it("marks redacted storage entries with redacted === true", () => {
    const out = redactStorageValue("access_token", "abc123");
    expect(out.value).toBe(REDACTED_VALUE);
    expect(out.redacted).toBe(true);
  });

  it("leaves benign storage keys and values untouched", () => {
    const out = redactStorageValue("theme", "dark");
    expect(out.value).toBe("dark");
    expect(out.redacted).toBeUndefined();
  });

  it("redacts cookie values under a sensitive cookie name", () => {
    const settings = makePrivacySettings("standard");
    const result = redactJsonValue(
      { sessionid: "deadbeefcafef00d" },
      settings,
      "storage",
      "storage.cookies",
      "body",
    );
    expect((result.value as Record<string, unknown>).sessionid).toBe(REDACTED_VALUE);
    expect(result.applied[0]?.artifact).toBe("storage");
  });

  /**
   * Property P3 (redaction): any storage entry whose key matches a sensitive
   * pattern is replaced by `REDACTED_VALUE` regardless of the underlying value.
   *
   * **Validates: Requirements 4.4**
   */
  it("never emits a raw value under a sensitive storage key", () => {
    // Keys that match the enabled credential-key rule under target "body".
    const sensitiveKeys = fc.constantFrom(
      "password",
      "token",
      "access_token",
      "refresh_token",
      "secret",
      "api_key",
      "authorization",
      "session",
      "csrf",
      "jwt",
    );

    fc.assert(
      fc.property(sensitiveKeys, fc.string({ minLength: 1 }), (key, secret) => {
        const out = redactStorageValue(key, secret);
        expect(out.value).toBe(REDACTED_VALUE);
        expect(out.redacted).toBe(true);
        // The raw secret never survives (unless the secret literally equals the
        // redaction marker, which is not a leak).
        if (secret !== REDACTED_VALUE) {
          expect(out.value).not.toBe(secret);
        }
      }),
    );
  });
});

describe("isUploadArtifactKey (R2.2)", () => {
  it('accepts "storage"', () => {
    expect(isUploadArtifactKey("storage")).toBe(true);
  });

  it('accepts "dom"', () => {
    expect(isUploadArtifactKey("dom")).toBe(true);
  });

  it("still accepts the existing artifact keys", () => {
    for (const key of [
      "consoleLogs",
      "networkRequests",
      "webSocketLogs",
      "report",
      "userEvents",
      "privacy",
      "diagnostics",
    ]) {
      expect(isUploadArtifactKey(key)).toBe(true);
    }
  });

  it("rejects unknown keys", () => {
    for (const key of ["", "storages", "Storage", "doms", "unknown"]) {
      expect(isUploadArtifactKey(key)).toBe(false);
    }
  });
});

describe("StorageArtifact round-trip serialize/parse (R2.5 / Property P4-round-trip)", () => {
  // Generators that only ever emit defined fields, so the serialized form is a
  // faithful representation that parses back to a deep-equal object.
  const keyValueArb: fc.Arbitrary<StorageKeyValue> = fc
    .record(
      {
        key: fc.string(),
        value: fc.string(),
        redacted: fc.boolean(),
      },
      { requiredKeys: ["key", "value"] },
    )
    .map((kv) => kv as StorageKeyValue);

  const cookieArb: fc.Arbitrary<CookieRecord> = fc
    .record(
      {
        name: fc.string(),
        value: fc.string(),
        domain: fc.domain(),
        path: fc.string(),
        expires: fc.integer({ min: -1, max: 4_102_444_800 }),
        size: fc.nat(4096),
        httpOnly: fc.boolean(),
        secure: fc.boolean(),
        sameSite: fc.constantFrom("Strict" as const, "Lax" as const, "None" as const),
        redacted: fc.boolean(),
      },
      { requiredKeys: ["name", "value", "domain", "path"] },
    )
    .map((c) => c as CookieRecord);

  const snapshotArb = fc.record({
    phase: fc.constantFrom("start" as const, "stop" as const),
    capturedAt: fc.integer({ min: 0, max: 4_102_444_800_000 }),
    localStorage: fc.array(keyValueArb, { maxLength: 8 }),
    sessionStorage: fc.array(keyValueArb, { maxLength: 8 }),
    cookies: fc.array(cookieArb, { maxLength: 8 }),
  });

  const artifactArb: fc.Arbitrary<StorageArtifact> = fc.record({
    schemaVersion: fc.constant(1 as const),
    snapshots: fc.array(snapshotArb, { maxLength: 2 }),
  });

  /**
   * Property P4-round-trip: a StorageArtifact survives serialize→parse
   * unchanged: `parse(JSON.stringify(artifact))` deep-equals `artifact`.
   *
   * **Validates: Requirements 2.5**
   */
  it("preserves a StorageArtifact through JSON serialize/parse", () => {
    fc.assert(
      fc.property(artifactArb, (artifact) => {
        const roundTripped = JSON.parse(JSON.stringify(artifact)) as StorageArtifact;
        expect(roundTripped).toEqual(artifact);
      }),
    );
  });

  it("round-trips a representative storage artifact example", () => {
    const artifact: StorageArtifact = {
      schemaVersion: 1,
      snapshots: [
        {
          phase: "start",
          capturedAt: 1700000000000,
          localStorage: [{ key: "theme", value: "dark" }],
          sessionStorage: [{ key: "token", value: REDACTED_VALUE, redacted: true }],
          cookies: [
            {
              name: "sid",
              value: REDACTED_VALUE,
              domain: "example.com",
              path: "/",
              expires: -1,
              httpOnly: true,
              secure: true,
              sameSite: "Lax",
              redacted: true,
            },
          ],
        },
      ],
    };
    expect(JSON.parse(JSON.stringify(artifact))).toEqual(artifact);
  });
});
