---
title: "API Conventions"
description: "Shared internal message and external platform API conventions."
type: shared
status: active
tags: ["api", "messages", "platform"]
source_paths:
  - "src/types/messages.ts"
  - "src/background/service-worker.ts"
  - "src/offscreen/offscreen.ts"
related:
  - "./data-models.md"
  - "../modules/recording-runtime.md"
  - "../modules/drive-and-player.md"
  - "../modules/privacy-and-redaction.md"
  - "../modules/replay-player.md"
  - "../features/extension-surfaces.md"
  - "../features/release-and-update-checks.md"
---

# API Conventions

## Meta

- Trạng thái: active
- Phạm vi: internal message contracts and external browser/cloud/Cloudflare APIs
- Nguồn code: `src/types/messages.ts`, `src/background/service-worker.ts`, `src/offscreen/offscreen.ts`
- Tuân thủ: Không áp dụng
- Links: [Shared Data Models](./data-models.md), [Recording Runtime](../modules/recording-runtime.md), [Cloud Storage And Player](../modules/drive-and-player.md), [Privacy And Redaction](../modules/privacy-and-redaction.md), [Replay Player](../modules/replay-player.md), [Extension Surfaces](../features/extension-surfaces.md), [Release Packaging](../features/release-and-update-checks.md)

## Internal Message Contracts

- popup and auth page never mutate shared state directly; they send commands to the service worker
- Settings and History pages also use service-worker commands for shared settings/history state instead of directly owning durable contracts
- offscreen messages must include `target: "offscreen"` so the service worker can ignore them in its main command handler
- injected recording-event scripts receive only the safe privacy/redaction settings needed for event sanitization and visual masking; they send `RECORDING_USER_EVENT` messages to the service worker with sanitized events, redaction hit summaries, and optional limitation notes. The service worker accepts those messages only for the current recording tab/session and treats them as best-effort replay metadata
- long-running flows return progress through fire-and-forget runtime messages plus `chrome.storage.session` state sync
- storage auth uses generic messages `STORAGE_CONNECT` / `STORAGE_DISCONNECT` / `STORAGE_STATUS` / `GET_STORAGE_TOKEN` with an optional `provider` field (`google-drive` | `dropbox`)
- legacy Google aliases (`GOOGLE_DRIVE_*`, `GET_GOOGLE_DRIVE_TOKEN`) map to the Google Drive provider in the message router
- replay player requests for `GET_STORAGE_TOKEN` / `GET_GOOGLE_DRIVE_TOKEN` return an in-memory OAuth token only to extension replay code; tokens are not encoded into replay URLs, upload history, package metadata, or standalone proxy requests

## External APIs

- `chrome.tabCapture`
  produces a tab stream ID that is forwarded to the offscreen document.
- `chrome.debugger`
  enables `Network`, `Runtime`, `Log`, and best-effort `Debugger` domains.
- `chrome.scripting`
  injects the lightweight recording-event collector and selector-based visual masking CSS into the active tab only after the user starts recording; the script is stopped during teardown and does not require broad host permissions.
- `chrome.tabs.captureVisibleTab`
  captures an optional stop-time screenshot for the replay report. Screenshot capture is best-effort and skipped when unavailable, blocked by the browser, or too large for the package guardrail.
- `chrome.identity`
  OAuth mechanism for cloud providers. Google Chrome may use `getAuthToken` for Drive; Dropbox, and non-Chrome Chromium typically use `launchWebAuthFlow` plus local token cache with PKCE. Production builds require matching extension identity env (`CHROME_EXTENSION_ID`, `CHROME_EXTENSION_PUBLIC_KEY`) and provider client ids as shipped.
- Manifest host permissions
  the Store manifest does not request broad host permissions; recording access is initiated through the user-selected active tab, `activeTab`, `tabCapture`, `chrome.scripting`, and temporary `chrome.debugger` attachment. Fixed host permissions are limited to OAuth/API endpoints for configured providers (and optional token-proxy origins).
- Google Drive REST APIs
  used for token verification, multipart upload, permission creation, token revocation, and authenticated replay package downloads through `files.get?alt=media` when the extension player has a Drive OAuth token.
- Dropbox APIs
  used for upload (including session upload for large files), shared-link creation, and authenticated download when available.
- Cloudflare Pages Functions
  - `/api/drive?id=<file-id>` — public Google Drive package proxy (confirmation pages, range headers)
  - `/api/dropbox?id=<shared-link-id>` — Dropbox shared-link content proxy (relative ids only)

## Boundary Rules

- UI pages are command clients; service worker state is the shared runtime contract.
- Offscreen document is the media/upload worker; it does not own popup state.
- Content script is recording-scoped and receives no plaintext ZIP password or cloud credential.
- Replay source-map rendering is artifact-backed; the player does not call page or source-map URLs during replay.
- Standalone replay uses same-origin Cloudflare proxies for cloud bytes because direct public downloads can fail browser CORS/CORP or large-file confirmation flows.
- OAuth client secrets never ship in the extension; optional Workers inject secrets per issuer (Google Worker is Google-shaped only).
