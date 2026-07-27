---
title: "Shared Data Models"
description: "Shared message, recording state, capture payload, storage, and replay data models."
type: shared
status: active
tags: ["data-models", "messages", "recording"]
source_paths:
  - "src/types/messages.ts"
  - "packages/replay-core/src/schema/capture.ts"
  - "packages/replay-core/src/schema/package.ts"
  - "packages/replay-core/src/write/package-writer.ts"
related:
  - "./api-conventions.md"
  - "../modules/recording-runtime.md"
  - "../modules/drive-and-player.md"
  - "../modules/privacy-and-redaction.md"
  - "../modules/replay-player.md"
  - "../features/extension-surfaces.md"
---

# Shared Data Models

## Meta

- Trạng thái: active
- Phạm vi: message envelopes, recording state, upload state, capture payloads, and replay storage semantics
- Nguồn code: `src/types/messages.ts`, `packages/replay-core/src/schema/`, `packages/replay-core/src/write/`
- Tuân thủ: Không áp dụng
- Links: [API Conventions](./api-conventions.md), [Recording Runtime](../modules/recording-runtime.md), [Drive And Player](../modules/drive-and-player.md), [Privacy And Redaction](../modules/privacy-and-redaction.md), [Replay Player](../modules/replay-player.md), [Extension Surfaces](../features/extension-surfaces.md)

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
  console/browser/exception payload with serialized args, optional source-mapped stack data, and bounded source snippets when acquired sourcemaps include `sourcesContent`. Error objects inside `args` can carry parsed `stackTrace` frames derived from textual V8 stacks so logged errors use the same source-map enrichment path as structured CDP stacks.
- `SerializedRemoteObject`
  compact console argument model with primitive values, object previews, class/description metadata, and optional Error `stackTrace` frames that have already passed source-map resolution and privacy redaction before replay.
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
  redacted navigation/click/contextmenu/scroll/focus/submit/key timeline entries captured by the injected page listener; the model stores selectors, short labels, relative timing, and coordinates when available, but not raw typed input. Pointer events may include `viewportWidth`/`viewportHeight` (CSS px at event time) for accurate replay placement after mid-session resize. `scroll` entries coalesce a continuous wheel burst into one entry with a `direction` (`up`/`down`) and accumulated `deltaY`. `key` entries store a privacy-safe display label (named keys, function keys, and Ctrl/Meta/Alt shortcuts such as `Enter`, `Esc`, `Ctrl+S`); printable single keys are recorded only outside form controls, and password/sensitive targets are never recorded as key events.
- `RecordingUserEventArtifact`
  wrapper artifact written to `events.json`, containing the session id, source page URL/title, and ordered `RecordingUserEvent` entries.
- `RedactionHit`
  redaction telemetry without raw values; it records artifact class, data class, action, sanitized field path, and rule id for privacy summaries.
- `RecordingPrivacySummary`
  replay privacy metadata written to `privacy.json`, including policy version, selected privacy profile, artifact flags, grouped redaction counts, and known limitations.
- `SourceMapDiagnosticsArtifact`
  technical source-map load status written to optional `diagnostics.json`; URLs are privacy-redacted before serialization, and the artifact stores load outcomes rather than full sourcemap content.

## Recording Package Artifact Taxonomy

The current replay package is one Google Drive zip file identified by the replay URL path. Its internal artifacts are:

- `recording-index.json`
  replay entrypoint metadata with schema version, folder/package information, artifact paths, and video part paths
- `manifest.json`
  package layout source of truth with video mime type, part sizes, folder id, and artifact filenames
- `metadata.json`
  recording timestamp, duration, page URL, start time, extension label/version, storage provider metadata, and video summary
- `video.part-XXX.webm`
  ordered media chunks that the player combines into one local video blob
- `console.json`
  optional console/browser/exception entries with serialized args, source-map-enriched locations, parsed Error object stacks when available, source snippets, and unresolved-frame status
- `network.json`
  optional compact network entries with request/response metadata, selected headers/bodies, redirects, timing, initiators, and source-map-enriched stack data
- `websocket.json`
  optional WebSocket connection records and sent/received frame summaries
- `report.json`
  optional replay report metadata and captured environment context
- `events.json`
  optional redacted navigation/click/contextmenu/scroll/focus/submit/key timeline
- `privacy.json`
  optional privacy profile, artifact flags, redaction counts, and known limitations
- `diagnostics.json`
  optional source-map load outcomes and failure reasons
- `agent-summary.json`
  optional bounded, ranked summary for coding agents: session/environment context, counts, deduplicated top errors with source-mapped origins, failed and slow requests, WebSocket totals, the user timeline, privacy limits, and a `truncation` map recording what each capped list omitted. Written by `src/offscreen/agent-summary.ts` via `buildAgentSummary` in `packages/replay-core`, which is also what MCP readers run for packages recorded before this artifact existed. Skipped (not an error) when the source artifacts are too large to re-parse during upload.
- `screenshot.jpg`
  optional visible-tab screenshot captured at stop time (legacy single auto-capture)
- `screenshots.json`
  optional annotated screenshot set: each entry carries the captured viewport, the reporter's caption, and a list of annotations (arrow, box, ellipse, freehand, note, highlight, redact) in coordinates normalised to 0..1 against that viewport. Images live at their own paths under `screenshots/`; an SDK-produced entry instead references a `dom.json` snapshot index because the SDK cannot rasterise a page. **`redact` regions are destroyed in the stored image before packaging** — a package must never ship one with `applied: "pending"`
- `instant-replay.json`
  optional rolling DOM buffer covering the seconds before the report, so a bug need not be reproduced. `windowMs` is what the buffer was configured to hold and `coveredMs` is what it actually held; the two differ whenever the producer's byte cap evicted frames first, and readers must reason about `coveredMs`

JSON/text entries may be DEFLATE-compressed inside the zip when compression reduces size. Media/image entries stay stored. Password-protected packages keep the same artifact shape but encrypt entry payloads with the configured ZIP password.

## Producers And Capabilities

Hai producer cùng ghi ra định dạng này, và cùng đi qua `packages/replay-core/src/write/`:

| Producer | `metadata.producer` | Ghi bằng | Thiếu gì |
| --- | --- | --- | --- |
| Extension | `"extension"` | CDP + `tabCapture` | — |
| Extension screenshot report | `"extension"` | `captureVisibleTab` + annotation editor | video |
| Browser SDK (`packages/sdk/`) | `"sdk"` | monkey-patch trong trang | video, ảnh raster, chi tiết cross-origin, cookie khác domain, source map |

`metadata.capabilities` liệt kê những gì producer **có thể** bắt, và reader phải rẽ nhánh theo đó chứ không theo sự hiện diện của artifact: một `console.json` vắng mặt vì phiên im lặng khác hẳn vắng mặt vì producer không bắt được console. Package ghi trước khi trường này tồn tại không có `capabilities`; `resolveCapabilities()` coi chúng là `EXTENSION_CAPABILITIES` vì khi đó chỉ có extension.

Điều này cho phép một package hợp lệ **không có** `video.part-*.webm`. Player kiểm tra `hasCapability(metadata, "video")` trước khi coi việc thiếu video là hỏng gói.

Ràng buộc này được kiểm bằng `test/conformance.test.ts`: mọi producer phải qua cùng một bộ assertion trong `packages/replay-core/src/testing/conformance.ts`, và bộ đó chấm điểm bằng chính reader đang ship.

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
