/**
 * Root extension Vitest config (the `node` Context).
 *
 * Runs the unit and property tests for `src/**` in a Node environment with the
 * shared Chrome API mock installed and reset between tests. This config is a
 * thin per-context layer over `sharedTestConfig`: it spreads the shared base
 * and declares only the keys that distinguish this Context (`environment` and
 * `setupFiles`). Coverage, reporters, the globals flag, and the include/exclude
 * globs are owned by `vitest.shared.ts` and are intentionally not redeclared
 * here so the resolved config cannot drift from the shared base.
 *
 * Root-only resolution: Vitest scopes test discovery and module resolution to
 * `root`, which defaults to the directory of this config file (the repo root).
 * That keeps this Context isolated from the `player/` and `worker/`
 * Contexts, which own their own configs. No `resolve.alias` map is needed: the
 * production extension build (esbuild, see `esbuild.config.mjs`) and
 * `tsconfig.json` use plain relative imports with no path aliases, so the
 * default Vite resolver resolves `src/**` imports exactly as in production.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { sharedTestConfig } from "./vitest.shared";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const rootAppVersion = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf-8"))
  .version as string;

export default defineConfig({
  // Mirror the build-time constants esbuild injects via `define` (see
  // `esbuild.config.mjs`). Modules such as `src/shared/player-host.ts` and
  // `src/background/google-drive-auth.ts` reference these globals at module
  // load time, so they must be defined for the test bundle too. Test-safe
  // placeholder values are used here (never real secrets); production values
  // come from `.env` at build time.
  define: {
    __APP_ENV__: JSON.stringify("test"),
    __APP_VERSION__: JSON.stringify(rootAppVersion),
    __BROWSER_TARGET__: JSON.stringify("chrome"),
    __GOOGLE_CLIENT_ID__: JSON.stringify(""),
    __GOOGLE_WEB_CLIENT_ID__: JSON.stringify(""),
    __GOOGLE_TOKEN_PROXY_URL__: JSON.stringify(""),
    __DROPBOX_CLIENT_ID__: JSON.stringify(""),
    __DROPBOX_TOKEN_PROXY_URL__: JSON.stringify(""),
    __FEEDBACK_PROXY_URL__: JSON.stringify(`http://localhost:63972/${rootAppVersion}/feedback`),

    __PLAYER_LOCAL_PORT__: JSON.stringify("5176"),
    // Empty → player-host falls back by __APP_ENV__ (test → production host).
    __PLAYER_HOST_URL__: JSON.stringify(""),
  },
  test: {
    ...sharedTestConfig,
    // Scope this (root) context to extension sources, shared packages, and root
    // test helpers only. Player-standalone and worker have their own configs and
    // are run separately by `task test:all`; without this override the root run
    // would execute every repo test under the wrong runtime.
    include: [
      "src/**/*.{test,spec}.ts",
      "packages/**/*.{test,spec}.ts",
      "test/**/*.{test,spec}.ts",
    ],
    environment: "node",
    setupFiles: ["./test/setup.ts", "./test/property-config.ts"],
  },
});
