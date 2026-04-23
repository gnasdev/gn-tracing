# Shared Data Models

- **Status**: Active
- **Version**: 0.1.0

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
  tracks `isRecording`, active `tabId`, `startTime`, console/network counters, and `hasRecording`.
- `UploadState`
  tracks in-flight upload progress, status message, generated recording URL, and error.

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
- Google Drive replay storage remains folder-scoped: each upload creates one folder with `metadata.json`, `manifest.json`, optional log JSON files, and ordered `video.part-XXX.webm` chunks
- the offscreen recorded video blob is retained only until upload completes successfully; after that the blob and recorder references are released
- source-map caches are temporary enrichment helpers and are discarded immediately after stored console/network artifacts are resolved
- replay links identify a recording by explicit Drive file IDs: `videos=<comma-separated-video-part-ids>`, `metadata=<file-id>`, and optional `console`, `network`, `websocket`
- standalone replay resolves those file IDs through the same-origin `/api/drive?id=<file-id>` proxy on Cloudflare Pages instead of browser-direct Drive fetches
