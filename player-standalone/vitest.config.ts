/**
 * Vitest configuration for the standalone replay player context.
 *
 * This config derives from the shared base (`../vitest.shared`) so coverage
 * settings, reporters, the globals flag, and the include/exclude globs stay
 * aligned with every other context. It declares only `environment: "jsdom"`
 * to distinguish the DOM-dependent player runtime, and merges the existing
 * Vite config so resolve/plugins behave like production.
 */

import { defineConfig, mergeConfig } from "vitest/config";
import { sharedTestConfig } from "../vitest.shared";
import viteConfig from "./vite.config";

export default mergeConfig(
  viteConfig({ command: "serve", mode: "test" }),
  defineConfig({
    test: {
      ...sharedTestConfig,
      environment: "jsdom",
      coverage: {
        ...sharedTestConfig.coverage,
        // Re-scope coverage for this Context. The shared base excludes
        // `player-standalone/**` so the repo-root coverage run never folds this
        // Context's source into the root report. When coverage runs *inside*
        // this Context that same glob would exclude this Context's own source
        // and report an empty (0/0) denominator, so we drop it here while still
        // excluding the other Context and all non-source. `include` stays unset
        // (per the shared base), so only files the suite exercises are counted.
        exclude: [
          "worker/**",
          "**/*.{test,spec}.ts",
          "**/*.config.{ts,mts,mjs,js}",
          "test/**",
          "scripts/**",
          "dist/**",
          "**/node_modules/**",
          "**/.wrangler/**",
        ],
      },
    },
  }),
);
