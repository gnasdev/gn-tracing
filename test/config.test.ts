/**
 * Config-inheritance test (Requirements 2.3, 2.4).
 *
 * Verifies that every per-context Vitest config derives the Shared_Config-owned
 * settings (coverage provider/reporters/thresholds, the globals flag, and the
 * include/exclude globs) from `vitest.shared.ts` and declares locally only the
 * key that distinguishes the Context: `environment` (root `node`, player
 * `jsdom`) or the worker `poolOptions` pool selection. The root config also
 * declares `setupFiles` to install the Chrome mock harness, which is the only
 * additional per-context key permitted by the design.
 *
 * The root config is imported and its resolved `test` block is inspected
 * directly. The player and worker configs pull in cross-context dependencies
 * (the player's Vite config, the Cloudflare Workers pool) that are not resolvable
 * from the root `node` Context, so they are asserted statically against their
 * source: they must spread `sharedTestConfig`, declare only their distinguishing
 * key, and never redeclare a Shared_Config-owned setting.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import rootConfig from "../vitest.config";
import { sharedTestConfig } from "../vitest.shared";

// The settings that `vitest.shared.ts` owns. A per-context config must inherit
// each of these unchanged and must never redeclare them.
const SHARED_OWNED_KEYS = ["globals", "coverage", "include", "exclude"] as const;

// Source-level tokens that would indicate a per-context config is redeclaring a
// Shared_Config-owned setting rather than inheriting it via the spread.
//
// Note on `coverage.exclude`: re-scoping coverage per Context is a deliberate,
// permitted lever (each sibling Context drops its OWN directory from the shared
// cross-context exclude list so it can measure its own source). It is therefore
// NOT one of the Shared_Config-owned settings enforced here. `provider:` is
// likewise permitted for the worker Context only, which must use Istanbul
// because the `workerd` runtime cannot run the V8 coverage provider. Both
// exceptions are asserted explicitly in the per-Context blocks below.
const FORBIDDEN_REDECLARATION_TOKENS = [
  "provider:",
  "reporter:",
  "thresholds",
  "include:",
  "globals:",
];

function readConfigSource(relativePath: string): string {
  const url = new URL(relativePath, import.meta.url);
  return readFileSync(url, "utf8");
}

describe("Vitest config inheritance", () => {
  describe("root extension config (node)", () => {
    const rootTest = (rootConfig as { test?: Record<string, unknown> }).test;

    it("resolves a test block", () => {
      expect(rootTest).toBeDefined();
    });

    it("inherits every Shared_Config-owned setting unchanged", () => {
      for (const key of SHARED_OWNED_KEYS) {
        expect(rootTest?.[key]).toEqual((sharedTestConfig as Record<string, unknown>)[key]);
      }
    });

    it("inherits the V8 coverage provider, reporters, and thresholds", () => {
      const coverage = rootTest?.coverage as {
        provider?: string;
        reporter?: string[];
        thresholds?: Record<string, number>;
      };
      expect(coverage.provider).toBe("v8");
      expect(coverage.reporter).toEqual(["text", "html", "lcov"]);
      expect(coverage.thresholds).toEqual({
        lines: 60,
        functions: 60,
        branches: 55,
        statements: 60,
      });
    });

    it("inherits the canonical include and shared exclude globs", () => {
      expect(rootTest?.include).toEqual(["**/*.{test,spec}.ts"]);
      expect(rootTest?.exclude).toEqual(["**/node_modules/**", "**/dist/**", "**/.wrangler/**"]);
    });

    it("overrides only environment and setupFiles", () => {
      const sharedKeys = Object.keys(sharedTestConfig as object);
      const extraKeys = Object.keys(rootTest ?? {}).filter((key) => !sharedKeys.includes(key));
      expect(extraKeys.sort()).toEqual(["environment", "setupFiles"]);
      expect(rootTest?.environment).toBe("node");
    });
  });

  describe("standalone player config (jsdom)", () => {
    const source = readConfigSource("../player-standalone/vitest.config.ts");

    it("derives from the shared base config", () => {
      expect(source).toContain("../vitest.shared");
      expect(source).toContain("...sharedTestConfig");
    });

    it("declares only the jsdom environment to distinguish the Context", () => {
      expect(source).toContain('environment: "jsdom"');
    });

    it("re-scopes only coverage.exclude (per-context lever), inheriting all else", () => {
      // Re-scoping `coverage.exclude` is permitted (it drops this Context's own
      // directory from the shared cross-context exclude list so the Context can
      // measure its own source). Every Shared_Config-owned setting — the
      // coverage provider, reporters, thresholds, the test include/exclude
      // globs, and the globals flag — must still be inherited via the spread.
      for (const token of FORBIDDEN_REDECLARATION_TOKENS) {
        expect(source).not.toContain(token);
      }
    });
  });

  describe("worker config (workers pool)", () => {
    const source = readConfigSource("../worker/vitest.config.ts");

    it("derives from the shared base config", () => {
      expect(source).toContain("../vitest.shared");
      expect(source).toContain("...sharedTestConfig");
    });

    it("declares only the workers pool selection to distinguish the Context", () => {
      expect(source).toContain("poolOptions");
      expect(source).toContain("workers");
    });

    it("overrides only the coverage provider (Istanbul), as the workerd runtime cannot run V8 coverage", () => {
      // Documented exception: the Cloudflare Workers pool executes tests inside
      // `workerd`, which has no `node:inspector` module, so the shared V8
      // coverage provider cannot run. The Worker Context therefore overrides
      // the provider to Istanbul. This is the only Shared_Config-owned setting
      // it is permitted to redeclare.
      expect(source).toContain('provider: "istanbul"');
    });

    it("re-scopes coverage and overrides only the provider, inheriting all else", () => {
      // The worker may re-scope `coverage.exclude` (per-context lever) and must
      // override the coverage provider to Istanbul (the workerd runtime cannot
      // run V8 coverage). Every other Shared_Config-owned setting — reporters,
      // thresholds, the test include/exclude globs, and the globals flag — must
      // still be inherited via the spread.
      const workerForbiddenTokens = FORBIDDEN_REDECLARATION_TOKENS.filter(
        (token) => token !== "provider:",
      );
      for (const token of workerForbiddenTokens) {
        expect(source).not.toContain(token);
      }
    });
  });
});
