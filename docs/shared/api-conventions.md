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
---

# API Conventions

## Meta

- Trạng thái: active
- Phạm vi: internal message contracts and external browser/Drive/Cloudflare APIs
- Nguồn code: `src/types/messages.ts`, `src/background/service-worker.ts`, `src/offscreen/offscreen.ts`
- Tuân thủ: Không áp dụng
- Links: [Shared Data Models](./data-models.md), [Recording Runtime](../modules/recording-runtime.md), [Drive And Player](../modules/drive-and-player.md)

## Internal Message Contracts

- popup and auth page never mutate shared state directly; they send commands to the service worker
- offscreen messages must include `target: "offscreen"` so the service worker can ignore them in its main command handler
- long-running flows return progress through fire-and-forget runtime messages plus `chrome.storage.session` state sync

## External APIs

- `chrome.tabCapture`
  produces a tab stream ID that is forwarded to the offscreen document.
- `chrome.debugger`
  enables `Network`, `Runtime`, `Log`, and best-effort `Debugger` domains.
- `chrome.identity`
  primary auth mechanism for Chrome; Edge uses `launchWebAuthFlow` plus locally stored access token fallback. OAuth builds require a matching `GOOGLE_CLIENT_ID`, `CHROME_EXTENSION_ID`, and `CHROME_EXTENSION_PUBLIC_KEY` so the generated manifest identity matches the Google Cloud OAuth client configuration.
- Manifest host permissions
  the Store manifest does not request broad host permissions; recording access is initiated through the user-selected active tab, `tabCapture`, and temporary `chrome.debugger` attachment. The only fixed host permission is `https://api.github.com/`, used by the popup update check to compare the installed version with the latest GitHub release.
- Google Drive REST APIs
  used for token verification, multipart upload, permission creation, token revocation, and authenticated replay package downloads through `files.get?alt=media` when the extension player has an OAuth token.
- Cloudflare Pages Function `/api/drive?id=<file-id>`
  proxies standalone replay downloads to `drive.usercontent.google.com`, resolves Google Drive confirmation pages for large public files, preserves range requests plus response content headers when the hosted player cannot use an OAuth token, and returns non-cacheable errors if Drive still responds with HTML instead of file bytes.
