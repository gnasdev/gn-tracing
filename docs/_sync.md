---
title: "Docs Sync State"
description: "Current synchronization state for the GN Tracing docs tree."
type: sync
status: active
tags: ["docs", "sync"]
---

# Docs Sync State

## Meta

- Synced commit: `HEAD`
- Synced at: `2026-05-12T00:00:00+07:00`
- Scope: Chrome Web Store readiness, capture privacy settings, Drive share-permission hardening, manifest permissions, Store validation task, and compliance docs
- Status: synced
- Known unsynced: Không có

## Current Snapshot

Docs describe the current architecture where GN Tracing records one Chromium tab, captures DevTools evidence in memory with privacy controls, uploads the finished session to Google Drive, and opens a hosted replay at `https://tracing.gnas.dev/<recording-index-file-id>`.

Replay storage is folder-scoped. Each upload writes `metadata.json`, `manifest.json`, `recording-index.json`, optional log artifacts, and ordered `video.part-XXX.webm` files. The recording index is the public entrypoint for the player; direct-file query params remain only as a legacy parser path.

The popup and history surfaces expose configurable Drive target folders, pause/resume, auto-upload when connected, capture privacy toggles, per-file upload progress, and recent upload history synced to Drive when auth is available. Popup capture controls and the capture queue are hidden until Drive is connected. Production extension builds require explicit OAuth/extension identity, and Store package validation runs through `Taskfile.yml`.
