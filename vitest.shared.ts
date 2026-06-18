/**
 * Shared base Vitest configuration for every test context in the repo.
 *
 * This is the single source of truth for coverage settings, reporters, the
 * globals flag, and the canonical test include/exclude globs. Each per-context
 * config (root extension `node`, standalone player `jsdom`, worker pool) spreads
 * `sharedTestConfig` and declares only the `environment` or worker pool that
 * distinguishes it, so the contexts stay aligned and do not drift.
 */

import type { UserConfig } from "vitest/config";

/**
 * Coverage threshold floor enforced during a coverage run. These ratchet upward
 * over time and must never be set below an established value.
 */
const coverageThresholds = {
  lines: 60,
  functions: 60,
  branches: 55,
  statements: 60,
} as const;

export const sharedTestConfig: UserConfig["test"] = {
  globals: true,
  coverage: {
    provider: "v8",
    reporter: ["text", "html", "lcov"],
    thresholds: coverageThresholds,
    // Do NOT set `include` here. With the V8 provider, declaring an `include`
    // glob switches coverage into "report every matching file" mode, which
    // pulls untested entrypoints/UI bundles from this Context (and, when run
    // from the repo root, the other Contexts' sources) into the denominator.
    // Leaving `include` unset keeps the report scoped to the source actually
    // exercised by the suite, and the excludes below drop everything that is
    // not this Context's own production logic.
    //
    // The root extension Context's test discovery spans the whole repo, so it
    // also executes the player/worker suites; the cross-context directory
    // excludes below keep those Contexts' sources out of the root coverage
    // report. Each sibling Context (player, worker) therefore re-scopes
    // `coverage.exclude` in its own config to drop only its OWN directory from
    // this list (so it measures its own source) while still excluding the other
    // Context. `coverage.exclude` is intentionally a per-context lever and is
    // NOT one of the Shared_Config-owned settings (coverage provider/reporters/
    // thresholds and the test include/exclude globs) that must be inherited
    // unchanged.
    exclude: [
      // Other test Contexts own their own coverage runs; never fold their
      // sources (or their executed test files) into this Context's denominator.
      "player-standalone/**",
      "worker/**",
      // Non-source: test files, test helpers/fixtures, config, build scripts,
      // and emitted bundles carry no production logic to measure.
      "**/*.{test,spec}.ts",
      "**/*.config.{ts,mts,mjs,js}",
      "test/**",
      "scripts/**",
      "dist/**",
      "**/node_modules/**",
      "**/.wrangler/**",
    ],
  },
  include: ["**/*.{test,spec}.ts"],
  exclude: ["**/node_modules/**", "**/dist/**", "**/.wrangler/**"],
};
