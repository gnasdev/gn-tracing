/**
 * Worker Vitest configuration.
 *
 * Runs the OAuth token-exchange Worker tests inside the real `workerd` runtime
 * via the Cloudflare Workers pool, so `fetch`-style handler tests get realistic
 * `Request`/`Response`/env bindings. It spreads the shared base config so
 * coverage, reporters, globals, and include/exclude globs stay aligned with the
 * other contexts, and declares only the worker pool that distinguishes it.
 */

import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import { sharedTestConfig } from "../vitest.shared";

export default defineWorkersConfig({
  test: {
    ...sharedTestConfig,
    coverage: {
      ...sharedTestConfig.coverage,
      // The Workers pool runs tests inside the real `workerd` runtime, which
      // has no `node:inspector` module, so the shared V8 coverage provider
      // cannot run here. Per Cloudflare's guidance, the Worker Context uses the
      // instrumented Istanbul provider instead. This is the single, documented
      // exception to the V8-everywhere default; reporters, the coverage floor,
      // the test globs, and the globals flag are all inherited from the shared
      // base via the spread above.
      provider: "istanbul",
      // Re-scope coverage for this Context: the shared base excludes `worker/**`
      // so the repo-root coverage run never folds this Context's source into the
      // root report. Running coverage *inside* this Context, that same glob would
      // exclude this Context's own source, so we drop it here while still
      // excluding the other Context and all non-source.
      exclude: [
        "player-standalone/**",
        "**/*.{test,spec}.ts",
        "**/*.config.{ts,mts,mjs,js}",
        "test/**",
        "scripts/**",
        "dist/**",
        "**/node_modules/**",
        "**/.wrangler/**",
      ],
    },
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          // `@cloudflare/vitest-pool-workers` requires the Node.js compat flag
          // to run the Worker under `workerd`. Declared here (test-only) so the
          // production `wrangler.toml` runtime config stays unchanged.
          compatibilityFlags: ["nodejs_compat"],
        },
      },
    },
  },
});
