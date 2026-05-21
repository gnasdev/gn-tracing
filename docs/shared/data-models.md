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
  console/browser/exception payload with serialized args, optional source-mapped stack data, and bounded source snippets when sourcemaps include `sourcesContent`.
- `NetworkEntry`
  request/response/timing/body/redirect metadata, plus initiator/source-map enrichment.
- `WebSocketEntry`
  connection metadata plus sent/received frames.
- `SourceCodeSnippet`
  compact source preview embedded on resolved console entries or frames; it stores only nearby lines, zero-based source coordinates, and truncation metadata.
- `ResolvedLocation`
  normalized source map result used to enrich console and initiator frames after capture ends, including a `SourceCodeSnippet` when source content is available.

## Storage Semantics

- service worker runtime state is mirrored into `chrome.storage.session` under `gn_tracing_state`
- Edge token fallback is stored in `chrome.storage.local`
- console/network/WebSocket capture payloads stay in memory only for the active post-recording flow and are cleared after a successful Google Drive upload
- Google Drive replay storage is package-scoped: each upload writes one `gn-tracing-*.zip` directly into the configured upload folder
- unprotected zips contain compact `metadata.json`, `manifest.json`, `recording-index.json`, optional log JSON files, and ordered `video.part-XXX.webm` chunks; JSON/text entries may use ZIP DEFLATE while video entries stay stored, and the hosted player URL references the zip file ID
- password-protected zips keep the normal recording package shape but protect entry payloads with a ZIP password; compressed JSON/text entries are compressed before encryption, and the player prompts for the password before loading artifacts
- zip password settings are stored locally in extension storage and only a `zipPasswordConfigured` boolean is exposed through popup state snapshots
- the offscreen recorded video blob is retained only until upload completes successfully; after that the blob and recorder references are released
- source-map caches are temporary enrichment helpers and are discarded immediately after stored console/network artifacts are resolved; replay artifacts retain only resolved locations and bounded source snippets, not full sourcemaps
- replay links identify a recording by the single zip file ID path, while legacy query-param replay links can still be parsed by the player for compatibility
- extension replay can resolve those file IDs through Google Drive API `files.get?alt=media` with the current in-memory OAuth token, while standalone replay resolves them through the same-origin `/api/drive?id=<file-id>` proxy on Cloudflare Pages when no token is available
- upload history is stored only in `chrome.storage.local`; it is not synced or written into Google Drive
