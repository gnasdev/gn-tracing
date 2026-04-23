# Spec Sync

- **Head Commit**: `cc08866e03aa84382fc72bc2b9f8895fdceb16f9`
- **Spec Status**: synced to current working tree architecture snapshot on 2026-04-23 after replay player layout controls, network response preview/highlighting, metadata-derived tab titles, parallel Drive transfer/loading, and byte-level progress reporting were added, while release CI remained build-and-package only and standalone Cloudflare deploy remained manual
- **Notes**:
  - `specs/` was initialized in this snapshot because the repository previously had no spec directory.
  - The sync target reflects current source architecture, not an older clean-tree baseline.
  - Replay storage uses one Google Drive folder per recording plus `manifest.json` and ordered `video.part-XXX.webm` files; replay URLs expose explicit artifact file IDs instead of `folderId`, and standalone playback downloads them through the Pages `/api/drive` proxy.
  - Player hosting is fixed to `https://tracing.gnas.dev/`; popup UI only displays that host and no longer supports editable player-host configuration.
  - Replay player UI now supports draggable pane resizing, persisted split percentage in `localStorage`, horizontal/vertical orientation switching, and an immersive in-tab video mode that hides the log pane instead of entering screen fullscreen.
  - Network detail in the replay player now derives response presentation from mime type and file extension, syntax-highlights JavaScript/HTML/CSS/JSON bodies, and renders inline preview panels for HTML, JSON, and base64-backed media responses.
  - Player title now derives a compact label from replay metadata URL plus record time and applies it to both the visible header and browser tab title for easier multi-tab differentiation.
  - Google Drive upload now transfers artifacts with bounded parallelism, keeps `manifest.json` as the final required upload after artifact IDs are known, and reports aggregate uploaded bytes plus percent through popup state updates.
  - Player loading still fans out artifact fetches in parallel, but video parts now download concurrently too and the loading screen shows transferred bytes plus percent.
  - Release automation is tag-driven via `.github/workflows/release.yml` and root `package.json` scripts, but it now stops at extension build plus zip artifact publishing; `player-standalone/deploy.sh` is no longer part of release CI.
  - Release CI also depends on a committed `player-standalone/package-lock.json`; ignoring that lockfile breaks the nested `npm ci` step on GitHub Actions.
  - Recording runtime now releases source-map caches after stop-time enrichment, compacts source-map fetch tracking as promises settle, and clears in-memory artifacts after successful Google Drive upload.
