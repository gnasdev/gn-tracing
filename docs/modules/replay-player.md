---
title: "Replay Player"
description: "Current replay player modes, package loading, password unlock, Drive downloads, and inspection UX."
type: module
status: active
tags: ["player", "replay", "google-drive"]
source_paths:
  - "player/player.js"
  - "player/player.css"
  - "player/player.html"
  - "player-standalone/src/main.ts"
  - "player-standalone/src/drive-adapter.ts"
  - "player-standalone/src/extension-detector.ts"
  - "player-standalone/functions/api/drive.js"
  - "player-standalone/scripts/sync-player.js"
related:
  - "./drive-and-player.md"
  - "./recording-runtime.md"
  - "./privacy-and-redaction.md"
  - "../shared/data-models.md"
  - "../shared/api-conventions.md"
---

# Replay Player

## Meta

- Trạng thái: active
- Phạm vi: extension/standalone replay player, Drive artifact download, zip package parsing, password unlock, loading progress, and inspection UI
- Nguồn code: `player/player.js`, `player/player.css`, `player/player.html`, `player-standalone/src/`, `player-standalone/functions/api/drive.js`, `player-standalone/scripts/sync-player.js`
- Tuân thủ: Không áp dụng
- Links: [Drive And Player](./drive-and-player.md), [Recording Runtime](./recording-runtime.md), [Privacy And Redaction](./privacy-and-redaction.md), [Shared Data Models](../shared/data-models.md), [API Conventions](../shared/api-conventions.md)

## Overview

The replay player is the viewer for uploaded GN Tracing recording packages. It loads a recording zip or legacy recording index from Google Drive, combines video parts locally, renders optional report artifacts, and synchronizes the video timeline with console, network, WebSocket, and user-event evidence.

The same `player/player.js` and `player/player.css` runtime is used by the packaged extension player and the hosted standalone player. Environment-specific behavior is kept behind browser globals, a standalone Drive adapter, and Cloudflare Pages routing.

## Modes And Entrypoints

- Extension mode can ask the service worker for a current Google Drive OAuth token and download packages through `files.get?alt=media`.
- Standalone mode uses the hosted URL at `https://tracing.gnas.dev/` and same-origin `/api/drive?id=<file-id>` downloads.
- The current replay URL shape is `https://tracing.gnas.dev/<zip-file-id>`.
- A legacy `?id=<file-id>` parser and direct-file query parser for `videos`, `metadata`, `console`, `network`, and `websocket` remain available for older/debug links.
- Opening the player without replay parameters shows an intro state instead of an invalid-params error.

## Package Loading

The primary package format is a single `gn-tracing-*.zip` containing:

- `recording-index.json`
- `manifest.json`
- `metadata.json`
- one or more ordered `video.part-XXX.webm` entries
- optional `report.json`, `events.json`, `privacy.json`, `diagnostics.json`, `screenshot.jpg`, `console.json`, `network.json`, and `websocket.json`

The player reads the zip central directory in-browser, validates entry sizes and CRC32, supports stored media entries, and inflates DEFLATE-compressed JSON/text entries when the browser provides `DecompressionStream`.

Optional artifacts are tolerant loads. Missing or corrupt report, event, privacy, diagnostics, or screenshot artifacts are warned/skipped without breaking video and log replay.

## Password And Compatibility Paths

Password-protected packages use traditional ZIP entry encryption in the current upload path. The player prompts for the recording password, decrypts entries in-browser, validates CRC32, and then uses the same parser path as unprotected packages.

The player also retains support for legacy encrypted-payload package indexes that describe an inner encrypted zip. That path is compatibility behavior, not the primary storage architecture.

Wrong or missing passwords stay client-side. The entered password is not placed in URLs, cache keys, uploaded metadata, or service-worker state.

## Drive Downloads And Proxy

The player downloads the recording package without requiring Drive folder listing for the current URL shape. Video parts are loaded with bounded concurrency and large video blobs skip Cache API storage to avoid first-load memory duplication.

Extension mode first tries authenticated Drive API media downloads when an OAuth token is available. If auth is unavailable or access failures may still succeed through a link-readable file, the player falls back to the public/proxy download path.

Standalone mode depends on the Cloudflare Pages `/api/drive` function. The function proxies public Drive downloads, preserves range and content headers, resolves Google Drive large-file confirmation pages, rejects unresolved HTML confirmation responses as non-cacheable errors, and advertises one-day cacheability for successful artifact bytes.

## Inspection UX

The player renders:

- report metadata, environment chips, privacy summary, optional screenshot, and redacted event timeline rows
- timeline markers from log evidence and user events
- searchable/filterable console, network, and WebSocket lists
- source-mapped console locations, parsed Error argument stacks, bounded source snippets, and source-map diagnostic messages
- network request/response details, headers, body text, cURL copy, response previews for HTML/media, syntax-highlighted source views, and JSON pretty preview when validation succeeds
- network and WebSocket initiator sections with source-mapped locations, full stack frames including async parent stacks, and source-map diagnostic messages
- draggable horizontal/vertical layout, persisted split percentage, and in-tab immersive video mode

## Source-Map Rendering

Replay does not fetch original source maps or application source files. Source-map work happens at capture stop time, and the player only renders what is present in the artifacts:

- resolved original source locations and names
- bounded source snippets from `sourcesContent`
- per-frame `sourceMapStatus` for generated-only frames
- package-level `diagnostics.json` fallback messages for missing maps, HTML/non-JSON map responses, HTTP failures, missing frame ids, or resolver misses

Parsed Error object stacks stored on `SerializedRemoteObject.stackTrace` are rendered separately from the raw Error description when present, so logged Error arguments can show source-mapped frames without reparsing source maps in replay.

## Relationships

- `drive-and-player` owns auth, upload, replay URL generation, package sharing, and standalone deployment boundaries.
- `recording-runtime` produces the artifacts that this player consumes.
- `privacy-and-redaction` defines the redacted values, privacy summaries, and source-snippet constraints that replay renders.
- `shared/data-models` defines the serialized artifact schemas used by both capture and replay.
