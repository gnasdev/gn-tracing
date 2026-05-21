---
title: "Docs Sync State"
description: "Current synchronization state for the GN Tracing docs tree."
type: sync
status: active
tags: ["docs", "sync"]
---

# Docs Sync State

## Meta

- Synced commit: `c3c6f1f68ba13dbb5210027cd3dcc15b92406dc3` plus current working tree changes
- Synced at: `2026-05-21T20:28:54+07:00`
- Scope: versioned release packaging, popup update checks, zip replay packages, native ZIP password-protected uploads, ZIP DEFLATE JSON/text artifact compression, compact replay artifact JSON, legacy encrypted-payload replay compatibility, source-map-enriched console source previews, OAuth Drive API media downloads, hardened standalone Drive proxy downloads, shared recording payload models, upload settings persistence, capture privacy defaults, and docs index
- Status: partially-synced
- Known unsynced: Current settings persistence, capture privacy default fixes, native ZIP password handling, and DEFLATE artifact compression are present in the working tree but not yet committed.

## Current Snapshot

Docs describe the current architecture where GN Tracing records one Chromium tab, captures DevTools evidence in memory with privacy controls, enriches console and initiator locations with sourcemaps, uploads the finished session as a Google Drive zip package, and opens a hosted replay at `https://tracing.gnas.dev/<zip-file-id>`.

Replay storage is package-scoped. Each upload writes one `gn-tracing-*.zip` directly into the configured upload folder. Unprotected zips contain compact `metadata.json`, `manifest.json`, `recording-index.json`, optional log artifacts, and ordered `video.part-XXX.webm` files. JSON/text entries are DEFLATE-compressed when that reduces size, while video entries stay stored. Password-protected uploads keep that package shape but protect ZIP entry payloads with the configured password after any entry compression, so downloaded archives prompt for the password in compatible unzip tools and the player unlocks entries before loading artifacts. Legacy encrypted-payload packages remain readable in the player. The zip file ID is the public entrypoint for the player; direct-file query params remain only as a legacy parser path.

Console replay artifacts can include bounded source snippets derived from sourcemap `sourcesContent` at capture stop time. The player renders those snippets in console detail views without fetching original sourcemaps or application source files during replay. When source content is unavailable, replay falls back to the resolved source file, line, column, and stack labels.

Replay downloads can use Google Drive API `files.get?alt=media` with the current in-memory OAuth token when the player runs in the extension context. Hosted standalone replay keeps `/api/drive` as the no-token fallback; that proxy resolves Google Drive's large-file confirmation pages, including form-based confirmation pages, before streaming artifact bytes to the browser. If Drive still returns HTML instead of a zip package or legacy JSON index, the proxy returns a non-cacheable error and the player removes stale cached HTML before retrying network downloads.

The popup and history surfaces expose configurable Drive target folders, optional zip password settings, start/stop/remove recording controls, auto-upload when connected, capture privacy toggles, per-file upload progress, release update checks, GitHub/contribution links, and recent upload history stored only in local extension storage. Upload settings can be recovered from the popup session snapshot when the durable local settings key is missing, then backfilled to local storage. Capture privacy toggles default to enabled for request bodies, response bodies, and WebSocket message payloads, and users can disable them before recording. Popup capture controls and the capture queue are hidden until Drive is connected. Production extension builds require explicit OAuth/extension identity, and Store package validation plus versioned release zip packaging run through `Taskfile.yml`.
