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
  covers recording lifecycle, Google Drive auth/status, upload commands, and injected user-event capture messages sent back to the service worker during an active recording.
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
  tracks the Drive target folder input, which defaults to `/gn-tracing`, the resolved folder ID, zip password status, capture profile, privacy profile, redaction controls, DOM masking selectors, advanced console/network/WebSocket capture modes, and optional byte limits where `null` means no limit.
- `UploadHistoryEntry`
  tracks recent uploaded replay links, Drive folder IDs, target folder scope, source page URL, and duration for popup/history UI.

## Capture Payload Models

- `ConsoleEntry`
  console/browser/exception payload with serialized args, optional source-mapped stack data, and bounded source snippets when acquired sourcemaps include `sourcesContent`.
- `NetworkEntry`
  request/response/timing/body/redirect metadata, plus initiator/source-map enrichment when inline or protocol-loaded external maps are available.
- `WebSocketEntry`
  connection metadata plus sent/received frames.
- `SourceCodeSnippet`
  compact source preview embedded on resolved console entries or frames; it stores only nearby lines, zero-based source coordinates, and truncation metadata.
- `ResolvedLocation`
  normalized source map result used to enrich console and initiator frames after capture ends, including a `SourceCodeSnippet` when source content is available.
- `SourceMapFrameStatus`
  per-frame source-map status serialized on generated-only console and network initiator frames when capture can explain why no original source location was produced; reasons include source-map load failures and resolver misses such as no matching generated line or segment.
- `RecordingReport`
  report-level metadata written to `report.json`, including the generated title, source page URL/title, timestamps, duration, log counts, environment context, and optional screenshot path.
- `CaptureEnvironment`
  browser/extension/page environment context collected at recording time, including viewport, screen, language, timezone, and user-agent-derived browser labels.
- `RecordingUserEvent`
  redacted navigation/click/focus/submit timeline entries captured by the injected page listener; the model stores selectors, short labels, relative timing, and coordinates when available, but not raw typed input.
- `RecordingUserEventArtifact`
  wrapper artifact written to `events.json`, containing the session id, source page URL/title, and ordered `RecordingUserEvent` entries.
- `RedactionHit`
  redaction telemetry without raw values; it records artifact class, data class, action, sanitized field path, and rule id for privacy summaries.
- `RecordingPrivacySummary`
  replay privacy metadata written to `privacy.json`, including policy version, selected privacy profile, artifact flags, grouped redaction counts, and known limitations.
- `SourceMapDiagnosticsArtifact`
  technical source-map load status written to optional `diagnostics.json`; URLs are privacy-redacted before serialization, and the artifact stores load outcomes rather than full sourcemap content.

## Storage Semantics

- service worker runtime state is mirrored into `chrome.storage.session` under `gn_tracing_state`
- Edge token fallback is stored in `chrome.storage.local`
- console/network/WebSocket capture payloads stay in memory only for the active post-recording flow and are cleared after a successful Google Drive upload
- capture settings are stored in `chrome.storage.local`; service worker snapshots expose only safe settings state, never the plaintext zip password
- Google Drive replay storage is package-scoped: each upload writes one `gn-tracing-*.zip` directly into the configured upload folder
- unprotected zips contain compact `metadata.json`, `manifest.json`, `recording-index.json`, optional `report.json`, optional `events.json`, optional `privacy.json`, optional `diagnostics.json`, optional `screenshot.jpg`, optional log JSON files, and ordered `video.part-XXX.webm` chunks; JSON/text entries may use ZIP DEFLATE while video/image entries stay stored, and the hosted player URL references the zip file ID
- password-protected zips keep the normal recording package shape but protect entry payloads with a ZIP password; compressed JSON/text entries are compressed before encryption, and the player prompts for the password before loading artifacts
- report, event, privacy, diagnostic, and screenshot artifacts are optional so older replay packages without them still load through the same player path
- zip password settings are stored locally in extension storage and only a `zipPasswordConfigured` boolean is exposed through UI state snapshots
- the offscreen recorded video blob is retained only until upload completes successfully; after that the blob and recorder references are released
- source-map caches are temporary enrichment helpers for inline `data:` maps and best-effort external `.map` files loaded through CDP `Network.loadNetworkResource`/`IO.read`; caches are discarded immediately after stored console/network artifacts are resolved, and replay artifacts retain only resolved locations, bounded source snippets, frame-level unresolved status, and optional redacted diagnostics, not full sourcemaps
- replay links identify a recording by the single zip file ID path, while legacy query-param replay links can still be parsed by the player for compatibility
- extension replay can resolve those file IDs through Google Drive API `files.get?alt=media` with the current in-memory OAuth token, while standalone replay resolves them through the same-origin `/api/drive?id=<file-id>` proxy on Cloudflare Pages when no token is available
- upload history is stored only in `chrome.storage.local`; it is not synced or written into Google Drive
