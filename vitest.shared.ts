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
    // pulls untested entrypoints/UI bundles from this Context into the
    // denominator. Leaving `include` unset keeps the report scoped to the
    // source actually exercised by the suite, and the excludes below drop
    // everything that is not production logic.
    //
    // Note: cross-context directory excludes (e.g. `player-standalone/**`) are
    // deliberately NOT listed. Each Context runs its own coverage pass and only
    // measures the source its own suite exercises, so it never imports another
    // Context's source. Listing a Context's own directory here would, when that
    // Context runs coverage in its own working directory, exclude its own
    // production source and report an empty (0/0) denominator.
    exclude: [
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
