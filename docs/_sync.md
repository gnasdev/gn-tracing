---
title: "Docs Sync State"
description: "Current synchronization state for the GN Tracing docs tree."
type: sync
status: active
tags: ["docs", "sync"]
---

# Docs Sync State

## Meta

- Synced commit: `8094ba2d99f87e32a730a4b3e0aee40644aaf939`
- Synced at: `2026-05-21T03:08:52+07:00`
- Scope: password-protected recording zip settings, encrypted upload package contract, player unlock flow, compliance wording, and docs index
- Status: synced
- Known unsynced: Không có

## Current Snapshot

Docs describe the current architecture where GN Tracing records one Chromium tab, captures DevTools evidence in memory with privacy controls, uploads the finished session as a Google Drive zip package, and opens a hosted replay at `https://tracing.gnas.dev/<zip-file-id>`.

Replay storage is package-scoped. Each upload writes one `gn-tracing-*.zip` directly into the configured upload folder. Unprotected zips contain `metadata.json`, `manifest.json`, `recording-index.json`, optional log artifacts, and ordered `video.part-XXX.webm` files. Password-protected uploads expose only encryption metadata plus encrypted payload bytes until the player receives the password and decrypts the inner recording zip. The zip file ID is the public entrypoint for the player; direct-file query params remain only as a legacy parser path.

The popup and history surfaces expose configurable Drive target folders, optional zip password settings, start/stop/remove recording controls, auto-upload when connected, capture privacy toggles, per-file upload progress, and recent upload history stored only in local extension storage. Popup capture controls and the capture queue are hidden until Drive is connected. Production extension builds require explicit OAuth/extension identity, and Store package validation runs through `Taskfile.yml`.
