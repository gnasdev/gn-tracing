---
title: "OAuth Token Proxy"
description: "Cloudflare Worker that holds the Google OAuth client secret and proxies the token exchange for the extension."
type: module
status: active
tags: ["oauth", "worker", "cloudflare", "drive", "auth"]
source_paths:
  - "worker/src/index.ts"
  - "worker/wrangler.toml"
  - "worker/deploy.sh"
  - "worker/.dev.vars.example"
  - "esbuild.config.mjs"
  - "src/background/google-drive-auth.ts"
  - "Taskfile.yml"
related:
  - "./drive-and-player.md"
  - "../shared/api-conventions.md"
---

# OAuth Token Proxy

## Meta

- Trạng thái: active
- Phạm vi: Server-side Google OAuth token exchange for the GN Tracing extension via a Cloudflare Worker
- Nguồn code: `worker/src/index.ts`, `worker/wrangler.toml`, `worker/deploy.sh`, `esbuild.config.mjs`, `src/background/google-drive-auth.ts`
- Tuân thủ: Không áp dụng
- Links: [Drive And Player](./drive-and-player.md), [API Conventions](../shared/api-conventions.md)

## 1. Overview

This module documents the optional Cloudflare Worker that performs the Google OAuth token exchange on behalf of the extension. The extension is a public client and must never bundle the OAuth `client_secret`. When the Google OAuth client is registered as a **Web application** type, Google rejects PKCE-only token requests with `invalid_request: client_secret is missing`. The Worker resolves this by holding the secret server-side and relaying the request to Google.

The Worker lives in `worker/` as a self-contained deployable, mirroring how `player-standalone/` owns the hosted player. It is wired into the extension at build time through the same `esbuild` define mechanism used for `GOOGLE_CLIENT_ID`.

For local development, `task worker:dev` runs `wrangler dev` with hot reload on `http://localhost:8787` (set in `wrangler.toml` `[dev]`). Local vars and the secret come from `worker/.dev.vars` (git-ignored; copy from `worker/.dev.vars.example`), which overrides the empty `[vars]` defaults. To exercise the extension against the local Worker, set `GOOGLE_TOKEN_PROXY_URL=http://localhost:8787` in the root `.env` and rebuild. `task dev` runs the extension watcher, the standalone player, and the Worker together.

## 2. Functional & Non-Functional Requirements

- Hold the Google OAuth `client_secret` as an encrypted Cloudflare secret; never expose it to the extension or in responses.
- Proxy both `authorization_code` and `refresh_token` grants to `https://oauth2.googleapis.com/token`.
- Preserve end-to-end PKCE: the extension still generates the `code_verifier` and forwards it; the Worker only injects `client_id` and `client_secret`.
- Relay Google's status code and JSON body verbatim so the extension's existing error handling is unchanged.
- Restrict callers to configured extension origin(s) so the endpoint cannot be used as an open token-minting proxy.
- Stay stateless: never persist tokens, codes, or verifiers.
- Deploy from the repository-root `.env`, matching `player-standalone/deploy.sh`.

## 3. Data Models & APIs

- `POST /` or `POST /token` — token exchange. Accepts `application/x-www-form-urlencoded` or JSON with `grant_type` plus the grant-specific fields (`code`, `code_verifier`, `redirect_uri` for authorization code; `refresh_token` for refresh). Returns Google's token JSON verbatim.
- `GET /health` — unauthenticated readiness probe returning `{ "ok": true, "service": "gn-tracing-oauth-proxy" }` for deploy verification.
- `OPTIONS` — CORS preflight; succeeds only for allowed origins.
- Worker environment: `GOOGLE_CLIENT_SECRET` (encrypted secret), `GOOGLE_CLIENT_ID` (public var), `ALLOWED_EXTENSION_ORIGINS` (comma-separated origin allow-list var).
- Extension build injects `GOOGLE_TOKEN_PROXY_URL` from `.env` into `__GOOGLE_TOKEN_PROXY_URL__` and appends the Worker origin to `dist/manifest.json` `host_permissions`. `src/background/google-drive-auth.ts` sends token requests to `GOOGLE_TOKEN_PROXY_URL` when set, otherwise directly to `https://oauth2.googleapis.com/token`.

## 4. Business Rules

- The Worker forwards only an allow-listed set of request fields (`grant_type`, `code`, `code_verifier`, `redirect_uri`, `refresh_token`); any client-supplied `client_id`/`client_secret` is ignored and replaced with the Worker's configured values.
- Only `authorization_code` and `refresh_token` grant types are accepted; all others return `unsupported_grant_type`.
- Requests without an allowed `Origin` are rejected with `403`. When `ALLOWED_EXTENSION_ORIGINS` is set, only those exact origins are allowed; when empty, any `chrome-extension://` origin is allowed as a development fallback.
- `deploy.sh` derives the allowed origin from `chrome-extension://${CHROME_EXTENSION_ID}` unless `WORKER_ALLOWED_EXTENSION_ORIGINS` is provided, and sets `GOOGLE_CLIENT_SECRET` via `wrangler secret put` before each deploy.
- When `GOOGLE_TOKEN_PROXY_URL` is unset, the extension keeps its direct-to-Google behavior, which only works for public/installed OAuth clients that accept PKCE without a secret.

## 5. Constraints & Assumptions

- The Worker is only required when the Google OAuth client is a Web application type; public/installed clients can continue calling Google directly without the Worker.
- `GOOGLE_CLIENT_SECRET` must be set in the deploy environment (`.env` or shell); it is intentionally git-ignored and never committed.
- The configured `GOOGLE_TOKEN_PROXY_URL` must match the deployed Worker URL exactly, because its origin is baked into `host_permissions` at build time; changing the Worker domain requires rebuilding the extension.
- `redirect_uri` is still produced by `chrome.identity.getRedirectURL()` in the extension and must remain an authorized redirect URI on the Google OAuth client.
- Deploying requires `wrangler`, `CLOUDFLARE_API_TOKEN`, and `CLOUDFLARE_ACCOUNT_ID`, matching the player deploy prerequisites.
- Local dev reads `worker/.dev.vars` (git-ignored) for both vars and the secret; `wrangler dev` hot-reloads the Worker on source changes and listens on `http://localhost:8787` by default.

## 6. Relationships

- Supports the web auth flow described in [Drive And Player](./drive-and-player.md) by performing its token exchange when a secret is required.
- Shares Google OAuth assumptions with [API Conventions](../shared/api-conventions.md).
- Reuses the repository `.env` configuration and `wrangler`/Cloudflare tooling already used by the standalone player deploy.

## 7. Related Decisions

- The project's original design treated the extension as a public client with no backend (see [Drive And Player](./drive-and-player.md)). The Worker is an additive, opt-in path for deployments whose Google OAuth client requires a `client_secret`; it does not change the default PKCE-only flow when `GOOGLE_TOKEN_PROXY_URL` is empty.
- The Worker is kept as a separate deployable under `worker/` rather than folded into the extension build, mirroring the `player-standalone/` boundary.
