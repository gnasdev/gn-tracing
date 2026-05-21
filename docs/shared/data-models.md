---
title: "Shared Data Models"
description: "Shared message, recording state, capture payload, storage, and replay data models."
type: shared
status: active
tags: ["data-models", "messages", "recording"]
source_paths:
  - "src/types/messages.ts"
  - "src/types/recording.ts"
related:
  - "./api-conventions.md"
  - "../modules/recording-runtime.md"
  - "../modules/drive-and-player.md"
---

# Shared Data Models

## Meta

- Trạng thái: active
- Phạm vi: message envelopes, recording state, upload state, capture payloads, and replay storage semantics
- Nguồn code: `src/types/messages.ts`, `src/types/recording.ts`
- Tuân thủ: Không áp dụng
- Links: [API Conventions](./api-conventions.md), [Recording Runtime](../modules/recording-runtime.md), [Drive And Player](../modules/drive-and-player.md)

## Messaging Models

- `MessageAction`
  covers recording lifecycle, Google Drive auth/status, and upload commands.
- `ServiceWorkerMessage`
  popup/auth page -> service worker command envelope.
- `OffscreenMessage`
  service worker -> offscreen command envelope with `target: "offscreen"`.
- `MessageResponse`
  generic response shape with `ok`, `error`, optional `message`, `recordingUrl`, `token`.

## Recording State Models

- `RecordingStatus`
  tracks active phase, tab/session IDs, elapsed recording time, source tab URL, and live console/network counters.
- `RecordingSessionSummary`
  tracks finished local/upload session status, local snapshot availability, progress, generated replay URL, Drive folder/index IDs, and errors.
- `UploadState`
  tracks in-flight upload progress, status message, generated recording URL, and error.
- `UploadSettings`
  tracks the Drive target folder input, which defaults to `/gn-tracing`, the resolved folder ID, capture privacy toggles, and whether a zip password is configured.
- `UploadHistoryEntry`
  tracks recent uploaded replay links, Drive folder IDs, target folder scope, source page URL, and duration for popup/history UI.

## Capture Payload Models

- `ConsoleEntry`
  console/browser/exception payload with serialized args and optional source-mapped stack data.
- `NetworkEntry`
  request/response/timing/body/redirect metadata, plus initiator/source-map enrichment.
- `WebSocketEntry`
  connection metadata plus sent/received frames.
- `ResolvedLocation`
  normalized source map result used to enrich console and initiator frames after capture ends.

## Storage Semantics

- service worker runtime state is mirrored into `chrome.storage.session` under `gn_tracing_state`
- Edge token fallback is stored in `chrome.storage.local`
- console/network/WebSocket capture payloads stay in memory only for the active post-recording flow and are cleared after a successful Google Drive upload
- Google Drive replay storage is package-scoped: each upload writes one `gn-tracing-*.zip` directly into the configured upload folder
- unprotected zips contain `metadata.json`, `manifest.json`, `recording-index.json`, optional log JSON files, and ordered `video.part-XXX.webm` chunks; the hosted player URL references the zip file ID
- password-protected zips contain clear encryption metadata plus `encrypted-payload.bin`; the decrypted payload is the normal recording zip, and the player prompts for the password before loading artifacts
- zip password settings are stored locally in extension storage and only a `zipPasswordConfigured` boolean is exposed through popup state snapshots
- the offscreen recorded video blob is retained only until upload completes successfully; after that the blob and recorder references are released
- source-map caches are temporary enrichment helpers and are discarded immediately after stored console/network artifacts are resolved
- replay links identify a recording by the single zip file ID path, while legacy query-param replay links can still be parsed by the player for compatibility
- standalone replay resolves those file IDs through the same-origin `/api/drive?id=<file-id>` proxy on Cloudflare Pages instead of browser-direct Drive fetches
- upload history is stored only in `chrome.storage.local`; it is not synced or written into Google Drive
