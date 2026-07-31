/**
 * Vitest configuration for the standalone SolidJS replay player (jsdom).
 *
 * Derives from the shared base (`../vitest.shared`) so coverage settings,
 * reporters, the globals flag, and the include/exclude globs stay aligned with
 * every other context. Declares `environment: "jsdom"` and re-scopes only
 * `coverage.exclude` (per-context lever) so this Context can measure its own
 * source. Solid plugin enables TSX under the player package.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import solid from "vite-plugin-solid";
import { defineConfig, mergeConfig } from "vitest/config";
import { sharedTestConfig } from "../vitest.shared";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootAppVersion = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf-8"),
).version as string;

export default mergeConfig(
  defineConfig({
    plugins: [solid()],
    define: {
      "import.meta.env.VITE_APP_VERSION": JSON.stringify(rootAppVersion),
    },
    resolve: {
      alias: {
        "@shared": path.resolve(__dirname, "../src/shared"),
        "@replay-core": path.resolve(__dirname, "../packages/replay-core/src"),
      },
    },
  }),
  defineConfig({
    test: {
      ...sharedTestConfig,
      environment: "jsdom",
      coverage: {
        ...sharedTestConfig.coverage,
        // Re-scope coverage for this Context. The shared base excludes
        // `player/**` so the repo-root coverage run never folds this
        // Context's source into the root report. When coverage runs *inside*
        // this Context that same glob would exclude this Context's own source
        // and report an empty (0/0) denominator, so we drop it here while still
        // excluding the other Context and all non-source.
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
