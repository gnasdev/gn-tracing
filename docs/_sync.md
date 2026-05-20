---
title: "Docs Sync State"
description: "Current synchronization state for the GN Tracing docs tree."
type: sync
status: active
tags: ["docs", "sync"]
---

# Docs Sync State

## Meta

- Synced commit: `1a1e99489f04f49b87b8af9e58fa1a6941ba3e80`
- Synced at: `2026-05-17T17:22:46+07:00`
- Scope: docs tree normalization, metadata consistency, internal link checks, compliance docs, module references, and sync metadata
- Status: synced
- Known unsynced: Không có

## Current Snapshot

Docs describe the current architecture where GN Tracing records one Chromium tab, captures DevTools evidence in memory with privacy controls, uploads the finished session to Google Drive, and opens a hosted replay at `https://tracing.gnas.dev/<recording-index-file-id>`.

Replay storage is folder-scoped. Each upload writes `metadata.json`, `manifest.json`, `recording-index.json`, optional log artifacts, and ordered `video.part-XXX.webm` files. The recording index is the public entrypoint for the player; direct-file query params remain only as a legacy parser path.

The popup and history surfaces expose configurable Drive target folders, start/stop/remove recording controls, auto-upload when connected, capture privacy toggles, per-file upload progress, and recent upload history synced to Drive when auth is available. Popup capture controls and the capture queue are hidden until Drive is connected. Production extension builds require explicit OAuth/extension identity, and Store package validation runs through `Taskfile.yml`.
