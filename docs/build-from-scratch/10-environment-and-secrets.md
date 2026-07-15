---
title: "10 - Environment and Secrets"
description: "Walkthrough of every variable in .env.example and where each one is consumed."
type: build
status: active
tags: ["build", "env", "secrets"]
related:
  - "./01-prerequisites.md"
  - "./04-extension-build-esbuild.md"
  - "./08-oauth-worker.md"
  - "./13-release-flow.md"
---

# 10 - Environment and Secrets

## Meta

- Goal: copy `.env.example` to `.env` and fill in only the variables your build needs.
- Verification: `node esbuild.config.mjs --env production` succeeds when the required-for-production variables are set.

## 10.1 `.env.example` Catalog

The file is at the repo root. Below is every key, where it is consumed, and whether it is required.

### `ENV`

| Key | Type | Required | Consumed by |
| --- | --- | --- | --- |
| `ENV` | `development\|production` | recommended | External orchestrators; `esbuild.config.mjs` also accepts `--env` flag |

The script reads `ENV` only if `--env` is omitted; the CLI flag wins.

### Google OAuth

| Key | Type | Required | Consumed by |
| --- | --- | --- | --- |
| `GOOGLE_CLIENT_ID` | string | yes for both envs | `esbuild.config.mjs` (manifest `oauth2.client_id`, `__GOOGLE_CLIENT_ID__`); `worker/deploy.sh` (`--var GOOGLE_CLIENT_ID`) |
| `GOOGLE_CLIENT_SECRET` | string | only if you deploy the Worker | `worker/deploy.sh` runs `wrangler secret put GOOGLE_CLIENT_SECRET` |
| `GOOGLE_TOKEN_PROXY_URL` | URL string | optional but mandatory in production when OAuth client is "Web application" | `esbuild.config.mjs` trims trailing slash, sets `__GOOGLE_TOKEN_PROXY_URL__`, and appends to `host_permissions` |
| `WORKER_ALLOWED_EXTENSION_ORIGINS` | CSV string | only if you deploy the Worker | `--var ALLOWED_EXTENSION_ORIGINS` on `wrangler deploy` |

Production builds hard-fail when `GOOGLE_TOKEN_PROXY_URL` is empty because a "Web application" OAuth client requires server-side secret injection.

### Chrome Extension Identity

| Key | Type | Required | Consumed by |
| --- | --- | --- | --- |
| `CHROME_EXTENSION_ID` | 32-char string | required in production | `esbuild.config.mjs` validates it matches the SHA-256 of the public key |
| `CHROME_EXTENSION_PUBLIC_KEY` | base64-DER | required always (manifest needs it) | `esbuild.config.mjs` substitutes into `manifest.json#key`; also derives the extension ID |
| `CHROME_EXTENSION_PRIVATE_KEY` | PEM PKCS#8 | optional; used for signing releases if you add a signing script | `esbuild.config.mjs` only warns if the value doesn't look like a PEM private key |

### Cloudflare

| Key | Type | Required | Consumed by |
| --- | --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | opaque token | required for `task player:deploy` and `task worker:deploy` | `wrangler pages deploy` and `wrangler deploy` |
| `CLOUDFLARE_ACCOUNT_ID` | alphanumeric | required for both deploys | `wrangler` commands |
| `CLOUDFLARE_PAGES_PROJECT` | string | required for player deploy | defaults to `gn-tracing-player` |

`player-standalone/deploy.sh` and `worker/deploy.sh` read these from the **process environment only** (they do not source repository `.env`). Export them in the shell or CI before `task player:deploy` / `task worker:deploy`.

### Player Hosting

| Key | Type | Required | Consumed by |
| --- | --- | --- | --- |
| `PLAYER_HOST_URL` | URL string | used at runtime only (e.g. when emitting replay links) | `src/shared/player-host.ts` and the popup's "Open replay" link |
| `PLAYER_LOCAL_PORT` | number string | recommended | `__PLAYER_LOCAL_PORT__` define constant (default `5176`) |
| `VITE_BASE_PATH` | string | only if you build the standalone player under a subpath | `Vite` configuration; defaults to `/` |

## 10.2 Putting It Together

A typical `.env` for local development without deploying the Worker:

```env
ENV=development
GOOGLE_CLIENT_ID=480452534376-na7me1e7ss7pmucni3vvkueai6gr8qpj.apps.googleusercontent.com
# GOOGLE_TOKEN_PROXY_URL not set: extension calls oauth2.googleapis.com directly (only works for public OAuth clients)
CHROME_EXTENSION_ID=
CHROME_EXTENSION_PUBLIC_KEY=<paste from chapter 01>
PLAYER_LOCAL_PORT=5176
```

A typical `.env` for production builds with the Worker deployed:

```env
ENV=production
GOOGLE_CLIENT_ID=<your prod client id>
GOOGLE_TOKEN_PROXY_URL=https://gn-tracing-oauth-proxy.<account>.workers.dev
CHROME_EXTENSION_ID=<derived id from chapter 01>
CHROME_EXTENSION_PUBLIC_KEY=<paste from chapter 01>
CLOUDFLARE_API_TOKEN=<cf token>
CLOUDFLARE_ACCOUNT_ID=<cf account id>
CLOUDFLARE_PAGES_PROJECT=gn-tracing-player
PLAYER_HOST_URL=https://tracing.gnas.dev/
PLAYER_LOCAL_PORT=5176
```

## 10.3 Loading Order in `esbuild.config.mjs`

The script reads:

```js
const envVars = loadEnvFile(path.resolve(__dirname, ".env"));
// ...
function getConfigValue(name, fallback = "") {
  return envVars[name] || process.env[name] || fallback;
}
```

So process environment variables override `.env`. This is why CI can put secrets in the runner environment and skip `.env` entirely.

## 10.4 Secrets Hygiene

- Never commit `.env` (the `.gitignore` from chapter `02` lists it).
- The private PEM stays local; rotate the keypair if it ever leaks.
- The Cloudflare API token should have only the scopes required for the project (`Workers Scripts: Edit`, `Cloudflare Pages: Edit`).
- Use `wrangler secret put` rather than commit for `GOOGLE_CLIENT_SECRET`.

## 10.5 Repo Secrets for `.github/workflows/release.yml`

Mirroring `.env`, GitHub Actions secrets follow the same names. Required for chapter `13`:

- `GOOGLE_CLIENT_ID`
- `CHROME_EXTENSION_ID`
- `CHROME_EXTENSION_PUBLIC_KEY`
- `CHROME_EXTENSION_PRIVATE_KEY`
- `CLOUDFLARE_API_TOKEN` (only if the release flow publishes the player)

## You Should Now Have

- `.env` populated with at minimum `GOOGLE_CLIENT_ID` + `CHROME_EXTENSION_PUBLIC_KEY`.
- Optional Cloudflare and Worker values when those surfaces are part of this build.
- A clear picture of which keys reach which file.

Move on to [11 - Testing](./11-testing-three-contexts.md).
