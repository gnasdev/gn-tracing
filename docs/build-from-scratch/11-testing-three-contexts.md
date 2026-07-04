---
title: "11 - Testing Three Contexts"
description: "Vitest setup for root (node), player (jsdom), and worker (workerd) test contexts."
type: build
status: active
tags: ["build", "testing", "vitest"]
related:
  - "./02-scaffolding.md"
  - "./06-extension-source-layers.md"
  - "./15-quality-gates.md"
---

# 11 - Testing Three Contexts

## Meta

- Goal: stand up three Vitest contexts (root extension, standalone player, OAuth Worker) that share the same base options and coverage thresholds.
- Verification: `task test:all` runs each context and exits 0; coverage thresholds are met.

## 11.1 The Shared Base

`vitest.shared.ts` (chapter `02`) owns:

```ts
export default defineProject({
  test: {
    globals: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      thresholds: {
        lines: 60,
        functions: 60,
        statements: 60,
        branches: 55,
      },
    },
    include: ["**/*.{test,spec}.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/coverage/**"],
  },
});
```

Each context below spreads the defaults and adds only what is unique.

## 11.2 Root Context

`vitest.config.ts` at the repo root:

```ts
import { defineConfig, mergeConfig } from "vitest/config";
import sharedTestConfig from "./vitest.shared";

export default mergeConfig(
  sharedTestConfig,
  defineConfig({
    test: {
      environment: "node",
      setupFiles: ["./test/setup.ts", "./test/property-config.ts"],
      coverage: {
        exclude: ["player-standalone/**", "worker/**"],
      },
    },
    define: {
      __APP_ENV__: JSON.stringify("test"),
      __GOOGLE_CLIENT_ID__: JSON.stringify("test-client-id"),
      __GOOGLE_TOKEN_PROXY_URL__: JSON.stringify(""),
      __PLAYER_LOCAL_PORT__: JSON.stringify("5176"),
    },
  }),
);
```

Key bits:

- `setupFiles` enables per-test `chrome.*` mocking.
- The define block keeps the build-time constants test-safe (no secrets leak into the test runner).

### Test Infrastructure

`test/setup.ts`:

```ts
import { beforeEach, afterEach } from "vitest";
import { installChromeMock, resetChromeMock } from "./mocks/chrome";

beforeEach(() => installChromeMock());
afterEach(() => resetChromeMock());
```

`test/mocks/chrome.ts` is a hand-rolled mock that covers `chrome.storage.session/local`, `chrome.runtime.sendMessage/onMessage/getURL`, `chrome.tabs.query/get/create/sendMessage`, `chrome.alarms.create/clear`, `chrome.debugger.attach/detach/sendCommand/onEvent`, and `chrome.action.setBadgeText/setBadgeBackgroundColor`. Any unmocked namespace throws so the team catches under-mocking fast.

`test/factories.ts` exports:

- `makeTab(...)` for tab-target validation tests.
- `makePrivacySettings(profile)` for redaction tests.
- `makeHeaderMap(...)` for header parsing tests.

`test/property-config.ts` configures `fast-check` globally:

```ts
import fc from "fast-check";
fc.configureGlobal({ numRuns: 100, verbose: true });
```

### Colocated Tests

Tests live next to the code they cover:

- `src/background/settings-store.test.ts`
- `src/background/storage-manager.test.ts`
- `src/background/sourcemap-resolver.test.ts`
- `src/content/in-page-capture-core.test.ts`
- `src/shared/*.test.ts` (most shared helpers)

Run from the repo root:

```bash
npm run test                # single run
npm run test:watch          # watch mode
npm run test:coverage       # with coverage report
```

## 11.3 Player Context

`player-standalone/vitest.config.ts`:

```ts
import { mergeConfig, defineConfig } from "vitest/config";
import viteConfig from "./vite.config";
import sharedTestConfig from "../vitest.shared";

export default mergeConfig(
  viteConfig,
  mergeConfig(
    sharedTestConfig,
    defineConfig({
      test: {
        environment: "jsdom",
        coverage: { exclude: ["worker/**"] },
      },
    }),
  ),
);
```

`jsdom` is required because the player code touches `window`, `document`, and `URLSearchParams`. Test files live alongside the player source (`src/*.test.ts`); a current canonical test is `src/zip-parser.test.ts`.

Run from `player-standalone/`:

```bash
npm run test
```

## 11.4 Worker Context

`worker/vitest.config.ts`:

```ts
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import sharedTestConfig from "../vitest.shared";

export default defineWorkersConfig({
  test: {
    ...sharedTestConfig.test,
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: { compatibilityFlags: ["nodejs_compat"] },
      },
    },
    coverage: { provider: "istanbul" },
  },
});
```

The Worker pool executes tests inside `workerd`. `coverage.provider` switches to `istanbul` because workerd does not expose `node:inspector`. `miniflare.compatibilityFlags: ["nodejs_compat"]` enables the `node:url`, `node:buffer`, etc. that the handler uses.

`worker/src/index.test.ts` colocates with the handler. Use the `cloudflare:test` helpers to retrieve `env`/`SELF`:

```ts
import { SELF, env } from "cloudflare:test";
import { it, expect } from "vitest";

it("rejects unknown origins", async () => {
  env.ALLOWED_EXTENSION_ORIGINS = "chrome-extension://abc";
  const res = await SELF.fetch("https://worker.local/", { method: "POST", body: "x=1" });
  expect(res.status).toBe(403);
});
```

Run from `worker/`:

```bash
npm run test
```

## 11.5 Pre-commit Hook

`.husky/pre-commit` runs:

1. `npx biome check --write --staged --files-ignore-unknown=true`
2. `npm run docs:check`
3. `vitest related --run --passWithNoTests` over staged `.ts` files (skipping `player-standalone/` and `worker/` which own their own runners)

This is the safety net that ensures every pushed change touched a corresponding test.

## 11.6 Notes

- `globals: true` means you can use `describe`/`it`/`expect` without imports; the repo still prefers imports for clarity in colocated tests.
- `fast-check` properties run 100 times by default, which catches off-by-one bugs without slowing local iteration.
- Coverage thresholds are intentionally moderate; chapter `15` keeps them from regressing via the pre-commit hook.

## You Should Now Have

- Three green test runs across root, player, and worker.
- A coherent `chrome.*` mock that every test reuses.
- Coverage thresholds met for each context.

Move on to [12 - Load Locally](./12-load-locally.md).
