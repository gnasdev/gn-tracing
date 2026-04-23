# Spec Sync

- **Head Commit**: `98570ffe50ae5fb50dee5546493035c1a08f31df`
- **Spec Status**: synced to current working tree architecture snapshot on 2026-04-23 after release CI was narrowed to build-and-package only, while standalone Cloudflare deploy remained manual
- **Notes**:
  - `specs/` was initialized in this snapshot because the repository previously had no spec directory.
  - The sync target reflects current source architecture, not an older clean-tree baseline.
  - Replay storage uses one Google Drive folder per recording plus `manifest.json` and ordered `video.part-XXX.webm` files; replay URLs expose explicit artifact file IDs instead of `folderId`, and standalone playback downloads them through the Pages `/api/drive` proxy.
  - Player hosting is fixed to `https://tracing.gnas.dev/`; popup UI only displays that host and no longer supports editable player-host configuration.
  - Release automation is tag-driven via `.github/workflows/release.yml` and root `package.json` scripts, but it now stops at extension build plus zip artifact publishing; `player-standalone/deploy.sh` is no longer part of release CI.
  - Release CI also depends on a committed `player-standalone/package-lock.json`; ignoring that lockfile breaks the nested `npm ci` step on GitHub Actions.
  - Recording runtime now releases source-map caches after stop-time enrichment, compacts source-map fetch tracking as promises settle, and clears in-memory artifacts after successful Google Drive upload.
