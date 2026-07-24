---
title: "OAuth Token Proxy"
description: "Cloudflare Worker multi-issuer OAuth token proxy (Google, Dropbox)."
type: module
status: active
tags: ["oauth", "worker", "cloudflare", "drive", "dropbox", "auth"]
source_paths:
  - "worker/src/index.ts"
  - "worker/wrangler.toml"
  - "worker/deploy.sh"
  - "worker/.dev.vars.example"
  - "esbuild.config.mjs"
  - "src/background/google-drive-auth.ts"
  - "src/background/dropbox-auth.ts"
  - "Taskfile.yml"
related:
  - "./drive-and-player.md"
  - "../shared/api-conventions.md"
---

# OAuth Token Proxy

## Meta

- Trạng thái: active
- Phạm vi: Server-side multi-issuer OAuth token exchange (Google and Dropbox) for the GN Tracing extension via one Cloudflare Worker. Secrets never ship in the extension.
- Nguồn code: `worker/src/index.ts`, `worker/wrangler.toml`, `worker/deploy.sh`, `worker/.dev.vars.example`, `esbuild.config.mjs`, auth modules under `src/background/`
- Tuân thủ: Không áp dụng
- Links: [Cloud Storage And Player](./drive-and-player.md), [API Conventions](../shared/api-conventions.md), [DEVELOPER.md](../../DEVELOPER.md)

## 1. Overview

The extension is a public client and must never bundle OAuth `client_secret` values. When a provider app is registered as a confidential / web-style client that requires a secret, this Worker holds the secret and relays `authorization_code` and `refresh_token` grants to the provider token endpoint. PKCE stays end-to-end: the extension still sends `code_verifier`; the Worker only injects `client_id` + `client_secret`.

### Routes

| Method | Path | Provider |
|--------|------|----------|
| POST | `/`, `/token`, `/token/google` | Google |
| POST | `/token/dropbox`, `/dropbox` | Dropbox |
| GET | `/health` | Readiness (no secret required) |

### Extension env

| Provider | Token proxy env | Typical production value |
|----------|-----------------|---------------------------|
| Google Drive | `GOOGLE_TOKEN_PROXY_URL` | `https://…workers.dev` (legacy base path) |
| Dropbox | `DROPBOX_TOKEN_PROXY_URL` | `https://…workers.dev/token/dropbox` |

Public PKCE clients can leave a proxy URL empty and call the provider token endpoint directly. See [DEVELOPER.md](../../DEVELOPER.md).

For local development, `task worker:dev` runs `wrangler dev` on `http://localhost:8787`. Local vars/secrets come from `worker/.dev.vars` (git-ignored; copy from `worker/.dev.vars.example`). Example: `DROPBOX_TOKEN_PROXY_URL=http://localhost:8787/token/dropbox`.

## 2. Functional & Non-Functional Requirements

- Hold provider OAuth `client_secret` values as encrypted Cloudflare secrets; never expose them to the extension or in responses.
- Proxy `authorization_code` and `refresh_token` grants to the correct upstream token endpoint per route (Google or Dropbox).
- Preserve end-to-end PKCE: the extension generates `code_verifier`; the Worker only injects `client_id` and `client_secret`.
- Relay the upstream status code and body verbatim so extension error handling is unchanged.
- Restrict callers to configured extension origin(s) so the endpoint cannot be used as an open token-minting proxy.
- Stay stateless: never persist tokens, codes, or verifiers.
- Deploy from process environment (or repo root `.env` via `deploy.sh`), matching player deploy secrets style.

## 3. Data Models & APIs

- `POST /token/google` (and legacy `/` | `/token`) — Google token exchange.
- `POST /token/dropbox` — Dropbox token exchange → `https://api.dropboxapi.com/oauth2/token`.
- Accepts `application/x-www-form-urlencoded` or JSON with allow-listed fields: `grant_type`, `code`, `code_verifier`, `redirect_uri`, `refresh_token`, `scope`.
- `GET /health` — `{ ok, service, providers: { google, dropbox } }` (booleans = id+secret configured).
- Secrets: `GOOGLE_CLIENT_SECRET`, `DROPBOX_CLIENT_SECRET`.
- Public vars: `GOOGLE_CLIENT_ID`, `DROPBOX_CLIENT_ID`, `ALLOWED_EXTENSION_ORIGINS`.
- Extension build injects each `*_TOKEN_PROXY_URL` into defines and appends proxy origins to `host_permissions`.

## 4. Business Rules

- Client-supplied `client_id` / `client_secret` are ignored; Worker credentials always win.
- Only `authorization_code` and `refresh_token` grant types are accepted.
- Requests without an allowed `Origin` return `403`. Empty allow-list falls back to any `chrome-extension://` origin (dev only).
- `deploy.sh` puts non-empty secrets, deploys public client ids, and prints the Google and Dropbox proxy URLs for `.env`.
- Missing id/secret for the route’s provider returns `500 server_misconfigured` without calling upstream.

## 5. Constraints & Assumptions

- Worker is only required when the provider app needs a secret; public PKCE clients can leave proxy URLs empty.
- Secrets must never be committed; use `wrangler secret put` / `worker/.dev.vars` / root `.env` (git-ignored).
- Proxy origins are baked into extension `host_permissions` at build time — changing Worker domain requires rebuild.
- `redirect_uri` still comes from `chrome.identity.getRedirectURL()` and must be authorized on each provider app.
- Deploy needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

## 6. Relationships

- Supports web auth flows in [Cloud Storage And Player](./drive-and-player.md) for Google and Dropbox when secrets are required.
- Shares origin-lock assumptions with [API Conventions](../shared/api-conventions.md).
- Reuses Cloudflare tooling with the standalone player deploy.

## 7. Related Decisions

- One multi-issuer Worker (path routing) instead of separate deployables per provider — shared origin lock, one health endpoint, one wrangler project.
- Legacy Google paths (`/`, `/token`) stay so existing `GOOGLE_TOKEN_PROXY_URL` base URLs keep working.
- Product still prefers public PKCE when the provider allows it; the Worker is additive for confidential clients.
