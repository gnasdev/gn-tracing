# Spec Sync

## Meta

- Synced commit: `05e65c1`
- Synced at: `2026-05-11T02:57:00Z`
- Scope: extension recording runtime, Google Drive OAuth identity, upload/replay, standalone player, release/developer docs, and specs tree
- Status: synced
- Known unsynced: Không có

## Current Snapshot

Specs describe the current architecture where GN Tracing records one Chromium tab, captures DevTools evidence in memory, uploads the finished session to Google Drive, and opens a hosted replay at `https://tracing.gnas.dev/<recording-index-file-id>`.

Replay storage is folder-scoped. Each upload writes `metadata.json`, `manifest.json`, `recording-index.json`, optional log artifacts, and ordered `video.part-XXX.webm` files. The recording index is the public entrypoint for the player; direct-file query params remain only as a legacy parser path.

The popup and history surfaces expose configurable Drive target folders, pause/resume, auto-upload when connected, per-file upload progress, and recent upload history synced to Drive when auth is available. Release automation remains tag-driven, injects OAuth/extension identity from repository secrets, and publishes only the manual unpacked-extension zip.
