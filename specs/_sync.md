# Spec Sync

- **Head Commit**: `e02e4711c5a18b3738863c5172b311a96c093a5f`
- **Spec Status**: synced to current working tree architecture snapshot on 2026-04-23 after Drive direct-file replay URL, chunked upload changes, and recording memory-retention cleanup
- **Notes**:
  - `specs/` was initialized in this snapshot because the repository previously had no spec directory.
  - The sync target reflects current source architecture, not a clean git tree baseline.
  - Replay storage now uses one Google Drive folder per recording plus `manifest.json` and ordered `video.part-XXX.webm` files; replay URLs pass explicit artifact file IDs instead of `folderId`, and standalone playback downloads them through the Pages `/api/drive` proxy.
  - Recording runtime now releases source-map caches after stop-time enrichment, compacts source-map fetch tracking as promises settle, and clears in-memory artifacts after successful Google Drive upload.
  - Working tree contains additional unstaged code changes outside `specs/`; these were treated as current HEAD-adjacent implementation context and not reverted.
