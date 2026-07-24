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
 * That keeps this Context isolated from the `player-standalone/` and `worker/`
 * Contexts, which own their own configs. No `resolve.alias` map is needed: the
 * production extension build (esbuild, see `esbuild.config.mjs`) and
 * `tsconfig.json` use plain relative imports with no path aliases, so the
 * default Vite resolver resolves `src/**` imports exactly as in production.
 */

import { defineConfig } from "vitest/config";
import { sharedTestConfig } from "./vitest.shared";

export default defineConfig({
  // Mirror the build-time constants esbuild injects via `define` (see
  // `esbuild.config.mjs`). Modules such as `src/shared/player-host.ts` and
  // `src/background/google-drive-auth.ts` reference these globals at module
  // load time, so they must be defined for the test bundle too. Test-safe
  // placeholder values are used here (never real secrets); production values
  // come from `.env` at build time.
  define: {
    __APP_ENV__: JSON.stringify("test"),
    __GOOGLE_CLIENT_ID__: JSON.stringify(""),
    __GOOGLE_TOKEN_PROXY_URL__: JSON.stringify(""),
    __DROPBOX_CLIENT_ID__: JSON.stringify(""),
    __DROPBOX_TOKEN_PROXY_URL__: JSON.stringify(""),

    __PLAYER_LOCAL_PORT__: JSON.stringify("5176"),
  },
  test: {
    ...sharedTestConfig,
    environment: "node",
    setupFiles: ["./test/setup.ts", "./test/property-config.ts"],
  },
});
