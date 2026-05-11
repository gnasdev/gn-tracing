---
title: "Docs Sync State"
description: "Current synchronization state for the GN Tracing docs tree."
type: sync
status: active
tags: ["docs", "sync"]
---

# Docs Sync State

## Meta

- Synced commit: `64627e3 + working tree`
- Synced at: `2026-05-11T03:27:43Z`
- Scope: extension recording runtime, Google Drive OAuth identity, upload/replay transfer performance, standalone player, Taskfile command runner, release/developer docs, and docs tree
- Status: synced
- Known unsynced: Không có

## Current Snapshot

Docs describe the current architecture where GN Tracing records one Chromium tab, captures DevTools evidence in memory, uploads the finished session to Google Drive, and opens a hosted replay at `https://tracing.gnas.dev/<recording-index-file-id>`.

Replay storage is folder-scoped. Each upload writes `metadata.json`, `manifest.json`, `recording-index.json`, optional log artifacts, and ordered `video.part-XXX.webm` files. The recording index is the public entrypoint for the player; direct-file query params remain only as a legacy parser path.

The popup and history surfaces expose configurable Drive target folders, pause/resume, auto-upload when connected, per-file upload progress, and recent upload history synced to Drive when auth is available. Popup capture controls and the capture queue are hidden until Drive is connected. Release automation remains tag-driven, injects OAuth/extension identity from repository secrets, runs through `Taskfile.yml`, and publishes only the manual unpacked-extension zip.
