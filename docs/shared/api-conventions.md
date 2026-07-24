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
- Phạm vi: internal message contracts and external browser/Drive/Cloudflare APIs
- Nguồn code: `src/types/messages.ts`, `src/background/service-worker.ts`, `src/offscreen/offscreen.ts`
- Tuân thủ: Không áp dụng
- Links: [Shared Data Models](./data-models.md), [Recording Runtime](../modules/recording-runtime.md), [Drive And Player](../modules/drive-and-player.md), [Privacy And Redaction](../modules/privacy-and-redaction.md), [Replay Player](../modules/replay-player.md), [Extension Surfaces](../features/extension-surfaces.md), [Release Packaging](../features/release-and-update-checks.md)

## Internal Message Contracts

- popup and auth page never mutate shared state directly; they send commands to the service worker
- Settings and History pages also use service-worker commands for shared settings/history state instead of directly owning durable contracts
- offscreen messages must include `target: "offscreen"` so the service worker can ignore them in its main command handler
- injected recording-event scripts receive only the safe privacy/redaction settings needed for event sanitization and visual masking; they send `RECORDING_USER_EVENT` messages to the service worker with sanitized events, redaction hit summaries, and optional limitation notes. The service worker accepts those messages only for the current recording tab/session and treats them as best-effort replay metadata
- long-running flows return progress through fire-and-forget runtime messages plus `chrome.storage.session` state sync
- replay player requests for `GET_GOOGLE_DRIVE_TOKEN` return an in-memory OAuth token only to extension replay code; tokens are not encoded into replay URLs, upload history, package metadata, or standalone proxy requests

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
  primary auth mechanism for Chrome; Edge uses `launchWebAuthFlow` plus locally stored access token fallback. OAuth builds require a matching `GOOGLE_CLIENT_ID`, `CHROME_EXTENSION_ID`, and `CHROME_EXTENSION_PUBLIC_KEY` so the generated manifest identity matches the Google Cloud OAuth client configuration.
- Manifest host permissions
  the Store manifest does not request broad host permissions; recording access is initiated through the user-selected active tab, `activeTab`, `tabCapture`, `chrome.scripting`, and temporary `chrome.debugger` attachment. Fixed host permissions are limited to Google OAuth/Drive endpoints (and an optional token-proxy origin).
- Google Drive REST APIs
  used for token verification, multipart upload, permission creation, token revocation, and authenticated replay package downloads through `files.get?alt=media` when the extension player has an OAuth token.
- Cloudflare Pages Function `/api/drive?id=<file-id>`
  proxies standalone replay downloads to `drive.usercontent.google.com`, resolves Google Drive confirmation pages for large public files, preserves range requests plus response content headers when the hosted player cannot use an OAuth token, and returns non-cacheable errors if Drive still responds with HTML instead of file bytes.

## Boundary Rules

- UI pages are command clients; service worker state is the shared runtime contract.
- Offscreen document is the media/upload worker; it does not own popup state.
- Content script is recording-scoped and receives no plaintext ZIP password or Drive credential.
- Replay source-map rendering is artifact-backed; the player does not call page or source-map URLs during replay.
- Standalone replay uses the same-origin Cloudflare proxy for Drive bytes because direct public Drive downloads can fail browser CORS/CORP or large-file confirmation flows.
