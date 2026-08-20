---
title: "08 - OAuth Token Proxy Worker"
description: "worker/ Cloudflare Worker that injects the Google OAuth client_secret server-side."
type: build
status: active
tags: ["build", "worker", "oauth", "cloudflare"]
related:
  - "./01-prerequisites.md"
  - "./04-extension-build-esbuild.md"
  - "./10-environment-and-secrets.md"
---

# 08 - OAuth Token Proxy Worker

## Meta

- Goal: deploy a Cloudflare Worker that exchanges Google OAuth codes/access-token refreshes server-side so the `client_secret` never enters the extension bundle.
- Verification: with `GOOGLE_TOKEN_PROXY_URL` set in `.env`, rebuilding the extension logs "OAuth token exchange routed through Worker" and `curl $GOOGLE_TOKEN_PROXY_URL -d '...'` returns a Google-format token JSON.

## 8.1 Folder Layout

```
worker/
├── package.json              wrangler, @cloudflare/vitest-pool-workers
├── wrangler.toml             worker name, dev port, vars
├── tsconfig.json
├── vitest.config.ts          workerd pool
├── deploy.sh                 deploy orchestration
├── .dev.vars.example         local secrets template
└── src/
    ├── index.ts              handler
    └── index.test.ts         colocated test
```

## 8.2 Initialise

```bash
mkdir -p worker
cd worker
npm init -y
npm install wrangler @cloudflare/vitest-pool-workers
npm install -D @cloudflare/workers-types typescript vitest
```

## 8.3 `wrangler.toml`

```toml
name = "gn-tracing-oauth-proxy"
main = "src/index.ts"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]

[dev]
port = 63972

[vars]
# Used at deploy time. Locally, .dev.vars overrides these.
GOOGLE_CLIENT_ID = "REPLACE_AT_DEPLOY"
ALLOWED_EXTENSION_ORIGINS = "REPLACE_AT_DEPLOY"
```

Secrets are **not** listed here. `GOOGLE_CLIENT_SECRET` is added by `wrangler secret put` so it stays encrypted.

## 8.4 `src/index.ts` (Skeleton)

```ts
interface Env {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;   // from `wrangler secret put`
  ALLOWED_EXTENSION_ORIGINS: string;
}

const ALLOWED_METHODS = "POST, OPTIONS";
const ALLOWED_HEADERS = "Content-Type";

function isAllowedOrigin(origin: string, env: Env): boolean {
  const list = env.ALLOWED_EXTENSION_ORIGINS.split(",").map((s) => s.trim());
  return list.includes(origin);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("Origin") ?? "";
    const allowed = isAllowedOrigin(origin, env);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": allowed ? origin : "",
          "Access-Control-Allow-Methods": ALLOWED_METHODS,
          "Access-Control-Allow-Headers": ALLOWED_HEADERS,
          "Vary": "Origin",
        },
      });
    }

    if (!allowed) {
      return new Response("forbidden", { status: 403 });
    }

    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }

    const params = new URLSearchParams(await request.text());
    params.set("client_id", env.GOOGLE_CLIENT_ID);
    params.set("client_secret", env.GOOGLE_CLIENT_SECRET);

    const upstream = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("Content-Type") ?? "application/json",
        "Access-Control-Allow-Origin": origin,
        "Vary": "Origin",
      },
    });
  },
};
```

The exact implementation in this repo also handles the `grant_type=refresh_token` and `grant_type=authorization_code` shapes; see `worker/src/index.ts` for the canonical version.

## 8.5 Origin Allowlist

`ALLOWED_EXTENSION_ORIGINS` is a comma-separated list. Defaults to:

```
chrome-extension://${CHROME_EXTENSION_ID}
```

When `GOOGLE_CLIENT_ID` is from a Google identity that needs `http://localhost` redirects (e.g. for the drive-auth page in development), add `http://localhost:63972` to the list.

## 8.6 `deploy.sh`

The deploy script:

1. Reads `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from the environment.
2. Optionally sets the `GOOGLE_CLIENT_SECRET` with `wrangler secret put GOOGLE_CLIENT_SECRET`.
3. Calls `wrangler deploy` with `--var GOOGLE_CLIENT_ID=$GOOGLE_CLIENT_ID` and `--var ALLOWED_EXTENSION_ORIGINS=$WORKER_ALLOWED_EXTENSION_ORIGINS`.

This file is the one the `task worker:deploy` alias invokes (chapter `09`).

## 8.7 Local Development

```bash
cd worker
cp .dev.vars.example .dev.vars      # GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ALLOWED_EXTENSION_ORIGINS
task worker:dev                     # -> wrangler dev --port 63972
```

Then in the root `.env` (chapter `10`):

```
GOOGLE_TOKEN_PROXY_URL=http://localhost:63972
```

Rebuild the extension so the manifest gains `http://localhost:63972/` in `host_permissions` (handled automatically by `addTokenProxyHostPermission()` from chapter `04`).

## 8.8 Testing

`worker/vitest.config.ts` uses `@cloudflare/vitest-pool-workers/config` so tests run inside `workerd`. A typical test imports the default export and asserts:

- Unknown origin is rejected with 403.
- `OPTIONS` preflight is allowed only for known origins.
- A POST with a valid body returns a stubbed Google response with the correct `client_id` and `client_secret` injected.

```ts
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

beforeEach(() => {
  env.ALLOWED_EXTENSION_ORIGINS = "chrome-extension://abc";
});

describe("oauth proxy", () => {
  it("rejects unknown origin", async () => {
    const res = await SELF.fetch("https://example.com/", { method: "POST", body: "x=1" });
    expect(res.status).toBe(403);
  });
});
```

## 8.9 Notes

- The Worker URL, once deployed, is the value you put into `GOOGLE_TOKEN_PROXY_URL` for production builds.
- Without `GOOGLE_TOKEN_PROXY_URL` set, the extension falls back to direct `https://oauth2.googleapis.com/token` calls. Production builds fail fast in that state (chapter `04`, `logTokenProxyStatus`).
- The Worker's `client_secret` lives only in Cloudflare's secret store; it is never bundled or shipped.

## You Should Now Have

- A Cloudflare Worker project at `worker/` that builds and deploys via `task worker:deploy`.
- A reachable dev URL at `http://localhost:63972` that proxies Google token exchanges.
- A `GOOGLE_TOKEN_PROXY_URL` value that the rebuilt extension picks up.

Move on to [09 - Taskfile Commands](./09-taskfile-commands.md).
