---
title: "Cloud Storage And Player"
description: "Multi-cloud auth, package upload, public share, namespaced replay URLs, and player download architecture (Google Drive, Dropbox)."
type: module
status: active
tags: ["storage", "drive", "dropbox", "player", "upload", "replay"]
source_paths:
  - "src/shared/storage-provider.ts"
  - "src/background/storage/"
  - "src/background/google-drive-auth.ts"
  - "src/background/dropbox-auth.ts"
  - "src/drive-auth/drive-auth.ts"
  - "src/offscreen/offscreen.ts"
  - "src/shared/player-host.ts"
  - "src/shared/google-drive-api.ts"
  - "src/shared/dropbox-api.ts"
  - "Taskfile.yml"
  - "DEVELOPER.md"
  - "player"
related:
  - "./recording-runtime.md"
  - "./privacy-and-redaction.md"
  - "./replay-player.md"
  - "./oauth-token-proxy.md"
  - "../features/extension-surfaces.md"
  - "../features/release-and-update-checks.md"
  - "../shared/data-models.md"
  - "../shared/api-conventions.md"
---

# Cloud Storage And Player

## Meta

- Trạng thái: active
- Phạm vi: multi-cloud storage (Google Drive and Dropbox), OAuth per provider, zip package upload, public-by-link share, namespaced replay URLs, release packaging, and built-in/standalone player integration
- Nguồn code: `src/shared/storage-provider.ts`, `src/background/storage/`, `src/background/*-auth.ts`, `src/offscreen/offscreen.ts`, `src/shared/player-host.ts`, `src/shared/*-api.ts`, `player/`
- Tuân thủ: Không áp dụng
- Links: [Recording Runtime](./recording-runtime.md), [Privacy And Redaction](./privacy-and-redaction.md), [Replay Player](./replay-player.md), [OAuth Token Proxy](./oauth-token-proxy.md), [Extension Surfaces](../features/extension-surfaces.md), [Release Packaging](../features/release-and-update-checks.md), [Shared Data Models](../shared/data-models.md), [API Conventions](../shared/api-conventions.md)

> **Filename note:** this module path remains `docs/modules/drive-and-player.md` for stable links. Product language is **cloud storage** (Google Drive + Dropbox).

## 1. Overview

GN Tracing uploads each recording as one shareable zip package to **the user's own cloud**, not a GN Tracing backend. The active storage provider is selected in Settings (`activeStorageProvider`).

| Provider id | User label | Replay path | Standalone proxy |
|-------------|------------|-------------|------------------|
| `google-drive` | Google Drive | `/gdrive/<file-id>` (new); bare `/<id>` legacy | `/api/drive?id=...` |
| `dropbox` | Dropbox | `/dropbox/<shared-link-id>` | `/api/dropbox?id=...` |

Core source areas:

- `src/shared/storage-provider.ts` — provider ids, URL parse/build
- `src/background/storage/` — `StorageProvider` registry and adapters
- `src/background/google-drive-auth.ts`, `dropbox-auth.ts` — per-provider OAuth + local token cache
- `src/drive-auth/drive-auth.ts` — Google Drive auth page (tab-based OAuth UX for Drive)
- `src/offscreen/offscreen.ts` — zip packaging + provider-specific upload/share
- `src/shared/google-drive-api.ts`, `dropbox-api.ts` — shared API helpers
- `src/shared/player-host.ts` — fixed hosted player base + namespaced replay URLs
- `player/*` — hosted player + per-provider download proxies

Replay inspection, zip password unlock, and package parsing are documented in [Replay Player](./replay-player.md). Redaction policy lives in [Privacy And Redaction](./privacy-and-redaction.md). Google-only token-secret proxy details live in [OAuth Token Proxy](./oauth-token-proxy.md).

## 2. Functional & Non-Functional Requirements

### Storage providers

- Allow the user to choose one active provider: Google Drive or Dropbox.
- Connect/disconnect OAuth for the active provider without a GN Tracing backend.
- Keep OAuth client ids configurable through `.env` / release secrets; never bundle OAuth client secrets in the extension.
- Persist folder input **per provider** so Drive paths do not overwrite Dropbox paths.
- Hard-fail upload if folder resolution, zip packaging, package upload, or public-share creation fails — never return a broken replay URL.

### Package and upload (provider-agnostic packaging)

- Upload each recording as one `gn-tracing-*.zip` into the configured folder (or cloud root).
- Optional zip password: password-protected ZIP written in-browser before upload; hosted player prompts for password.
- Split recorded video into `<= 32 MB` parts when needed; seek-fix WebM when possible.
- JSON/text zip entries use ZIP DEFLATE when smaller; video WebM stays stored.
- Bounded-parallelism upload transfers with throttled progress; share creation does not occupy the file-upload worker slot.
- Emit `metadata.storage.provider` from the active provider.

### Replay URLs

- New uploads use namespaced paths: `/gdrive/<id>`, `/dropbox/<id>.
- Legacy bare Google Drive file-id URLs remain parseable forever as `google-drive`.
- Replay host is fixed: `https://tracing.gnas.dev/`.
- Extension player uses the active provider OAuth token for authenticated download when available; never places tokens in URLs, history, package metadata, Cache API keys, or proxy query strings.
- Standalone player uses same-origin proxies per provider when no token is available.

### Auth UX and release

- Keep auth UI resilient to popup lifetime (dedicated Drive auth page for Google; Dropbox uses `launchWebAuthFlow` from the popup connect path).
- Keep extension runtime state mirrored into popup/auth snapshots without live cloud verification on every progress write.
- Keep standalone player deployable to Cloudflare Pages separately from GitHub extension releases.

## 3. Data Models & APIs

### Provider contract

```ts
type StorageProviderId = "google-drive" | "dropbox";
```

Registry: `src/background/storage/registry.ts` selects the adapter for Settings `activeStorageProvider`.

Messages (generic + legacy aliases):

- `STORAGE_CONNECT` / `STORAGE_DISCONNECT` / `STORAGE_STATUS` / `GET_STORAGE_TOKEN` with optional `provider`
- Legacy `GOOGLE_DRIVE_*` / `GET_GOOGLE_DRIVE_TOKEN` map to Google Drive

### Auth and tokens

| Provider | Client env | Optional secret proxy | Token cache |
|----------|------------|----------------------|-------------|
| Google Drive | `GOOGLE_CLIENT_ID` | `GOOGLE_TOKEN_PROXY_URL` (Google-shaped Worker) | Chrome `getAuthToken` or web PKCE + `gn_tracing_webauth_tokens` |
| Dropbox | `DROPBOX_CLIENT_ID` | `DROPBOX_TOKEN_PROXY_URL` (Dropbox-aware; Google Worker does **not** apply) | Local cache key for Dropbox |

See [DEVELOPER.md](../../DEVELOPER.md) for redirect URIs, scopes, and rebuild notes.

### Package shape

- Unprotected and password-protected packages share the same entry layout: compact `metadata.json`, `manifest.json`, `recording-index.json`, optional report/events/privacy/diagnostics/screenshot/log files, and `video.part-XXX.webm` parts.
- `manifest.json` records schema version, target folder, video mime/parts, and optional artifact flags.
- `recording-index.json` is the replay entrypoint.

### Replay URL and download

- Helper: `buildStorageRecordingPath` / `parseStorageRecordingRef` in `src/shared/storage-provider.ts` (player reimplements parse rules in `player/player.js`).
- Extension authenticated download:
  - Google: Drive API `files.get?alt=media&supportsAllDrives=true`
  - Dropbox: provider media/download endpoints when token available
- Standalone proxies (SSRF-hardened: no absolute upstream URLs from query):
  - `/api/drive` — Google public download + large-file confirmation handling
  - `/api/dropbox` — relative shared-link ids only (`s/`, `scl/`, `sh/`, `sm/`)

### Canonical share ids

| Provider | After `makePublicReadable` |
|----------|----------------------------|
| Google Drive | Drive file id; permission `anyone` / `reader` |
| Dropbox | Canonical shared-link id used in `/dropbox/<id>` (not necessarily raw file id) |

## 4. Business Rules

### Multi-cloud auth and settings

- Active provider comes from Settings; popup Connect/Disconnect applies to that provider only.
- Disconnect revokes tokens best-effort, clears that provider's local token cache, and does **not** delete cloud files or upload history.
- Token caches are per-provider; disconnecting A does not clear B.
- Chrome Google auth uses `chrome.identity.getAuthToken`; other Chromium browsers use `launchWebAuthFlow` with PKCE + refresh where supported. Capability detection may fall back to web flow when Chrome brand is spoofed.
- Google web token endpoint is `https://oauth2.googleapis.com/token` or `GOOGLE_TOKEN_PROXY_URL` when the OAuth client requires a secret ([OAuth Token Proxy](./oauth-token-proxy.md)).
- Service worker re-hydrates storage connection mirrors on startup so popup paint is correct before full revalidation.
- Snapshot state exposes `storage: { provider, isConnected }` (with transitional `googleDrive` shim where still present).

### Upload happy path (all providers)

1. User selects provider + connects OAuth.
2. Stop recording → offscreen builds zip (shared pipeline).
3. Resolve upload folder for that provider.
4. Upload package with progress.
5. Make package public-readable (hard-fail on share failure).
6. Build namespaced replay URL; write history + `metadata.storage`.

### Folder input

- Google Drive: `/folder/path`, folder id, or Drive folder URL; blank or `/` → root. Default product path `/gn-tracing`.
- Dropbox: path such as `/gn-tracing`; created on upload if missing; blank → root.

### Sharing and password

- Public-by-link is required for standalone anonymous replay.
- Zip password protects package contents, not cloud discoverability of the link-readable file.
- Service-worker settings snapshots expose only whether a zip password is configured; plaintext password stays out of popup state, history, URLs, and package metadata.

### Progress and recovery

- Popup upload status surfaces aggregate bytes/percent and per-file rows; progress is throttled, state transitions immediate.
- Popup-visible recording lifecycle phases: `idle`, `recording`, `recorded`, `uploading`, `interrupted`.
- Auto-upload after stop when the active provider already has a valid token.
- Upload history is local extension storage only (not written to any cloud).

### Player package rules (shared)

- Player unpacks store-only and DEFLATE packages; password unlock decrypts in-browser.
- Optional artifacts are tolerant loads.
- Layout preferences live in per-origin `localStorage`.
- Player `document.title` uses `GN Tracing - <web title>`; the topbar shows the product brand plus the recorded page/web title (CSS-truncated), without video duration.

## 5. Constraints & Assumptions

- Uploads require publicly shareable cloud permissions for standalone replay links.
- Password-protected uploads use native ZIP password entries; forgotten passwords cannot be recovered by GN Tracing.
- Standalone mode depends on the matching same-origin proxy for the provider unless extension OAuth supplies a token.
- Local production builds require explicit OAuth/extension identity env for Google Store builds; Dropbox client id is required only when shipping Dropbox.
- Manual Cloudflare Pages deploy expects project `gn-tracing-player`, secrets `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`.
- Extension and standalone player builds remain separate pipelines.
- Telemetry-free: OAuth tokens and package file contents must not be written to logs, analytics, or remote telemetry (see compliance privacy policy).

## 6. Relationships

- consumes recording artifacts from `recording-runtime`
- applies package content protection and privacy boundaries from `privacy-and-redaction`
- delegates package load/inspection to `replay-player`
- receives configuration and history commands through `extension-surfaces`
- Google secret exchange optionally uses `oauth-token-proxy`; Dropbox confidential clients need a separate proxy URL
- depends on `shared/api-conventions` for identity + cloud API assumptions
- shares release packaging metadata with `manifest.template.json`, `Taskfile.yml`, `DEVELOPER.md`

## 7. Related Decisions

- Multi-cloud phased as P0 abstraction → P1 Dropbox → P3 compliance (OneDrive was removed; product is Drive + Dropbox).
- New Google uploads emit `/gdrive/<id>`; bare ids remain legacy-only.
- Hard-fail if public share cannot be created.
- OneDrive was explored then removed: personal OneDrive cannot reliably serve anonymous share downloads for the player.
- Auth page for Google remains a first-class surface; other providers connect via popup + `launchWebAuthFlow`.
- Standalone distribution stays on Cloudflare Pages; tag releases publish extension zip only.
