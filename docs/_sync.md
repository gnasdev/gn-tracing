---
title: "Docs Sync State"
description: "Current synchronization state for the GN Tracing docs tree."
type: sync
status: active
tags: ["docs", "sync"]
---

# Docs Sync State

## Meta

- Synced commit: `fc72b6eac8d13e5eb4d37c02cf2f5f8759400461`
- Synced at: `2026-05-21T15:32:11+07:00`
- Scope: versioned release packaging, popup update checks, zip replay packages, optional encrypted replay packages, source-map-enriched console source previews, OAuth Drive API media downloads, hardened standalone Drive proxy downloads, shared recording payload models, and docs index
- Status: synced
- Known unsynced: Không có

## Current Snapshot

Docs describe the current architecture where GN Tracing records one Chromium tab, captures DevTools evidence in memory with privacy controls, enriches console and initiator locations with sourcemaps, uploads the finished session as a Google Drive zip package, and opens a hosted replay at `https://tracing.gnas.dev/<zip-file-id>`.

Replay storage is package-scoped. Each upload writes one `gn-tracing-*.zip` directly into the configured upload folder. Unprotected zips contain `metadata.json`, `manifest.json`, `recording-index.json`, optional log artifacts, and ordered `video.part-XXX.webm` files. Password-protected uploads expose only encryption metadata plus encrypted payload bytes until the player receives the password and decrypts the inner recording zip. The zip file ID is the public entrypoint for the player; direct-file query params remain only as a legacy parser path.

Console replay artifacts can include bounded source snippets derived from sourcemap `sourcesContent` at capture stop time. The player renders those snippets in console detail views without fetching original sourcemaps or application source files during replay. When source content is unavailable, replay falls back to the resolved source file, line, column, and stack labels.

Replay downloads can use Google Drive API `files.get?alt=media` with the current in-memory OAuth token when the player runs in the extension context. Hosted standalone replay keeps `/api/drive` as the no-token fallback; that proxy resolves Google Drive's large-file confirmation pages, including form-based confirmation pages, before streaming artifact bytes to the browser. If Drive still returns HTML instead of a zip package or legacy JSON index, the proxy returns a non-cacheable error and the player removes stale cached HTML before retrying network downloads.

The popup and history surfaces expose configurable Drive target folders, optional zip password settings, start/stop/remove recording controls, auto-upload when connected, capture privacy toggles, per-file upload progress, release update checks, GitHub/contribution links, and recent upload history stored only in local extension storage. Popup capture controls and the capture queue are hidden until Drive is connected. Production extension builds require explicit OAuth/extension identity, and Store package validation plus versioned release zip packaging run through `Taskfile.yml`.
