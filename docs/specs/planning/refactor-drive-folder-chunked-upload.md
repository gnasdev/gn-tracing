# Drive Folder Recording Index Replay

- **Status**: Implemented
- **Owner**: Codex

## 1. Objective

GN Tracing stores every uploaded recording in a dedicated Google Drive folder and exposes a short replay URL keyed by the uploaded `recording-index.json` file ID. The player loads that index first, then fetches metadata, manifest, optional log artifacts, and ordered video parts through the Cloudflare Pages Drive proxy.

## 2. Current Architecture

- `src/offscreen/offscreen.ts` creates a recording folder, uploads required and optional artifacts, writes `manifest.json`, writes `recording-index.json`, and returns `buildExternalPlayerUrl(indexFileId)`.
- `src/shared/player-host.ts` builds replay URLs as `https://tracing.gnas.dev/<recording-index-file-id>` in production and uses the local Vite player host in development builds.
- `player/player.js` resolves the recording index from the path or `id` query param, downloads `recording-index.json`, then downloads referenced artifacts by file ID.
- `player-standalone/functions/api/drive.js` proxies Drive downloads at `/api/drive?id=<file-id>` and preserves range/content headers needed by player loading.
- Legacy direct-file query params remain parser-compatible for older links and debugging, but new uploads use the recording index path.

## 3. Storage Contract

Each recording folder contains:

- `metadata.json`
- `manifest.json`
- `recording-index.json`
- optional `console.json`, `network.json`, and `websocket.json`
- one or more `video.part-XXX.webm` files

`manifest.json` describes storage layout and artifact availability. `recording-index.json` contains the Drive file IDs the player needs to fetch the manifest, metadata, optional artifacts, and video parts.

## 4. Runtime Rules

- Required upload failures for folder creation, metadata, manifest, recording index, or video parts fail the upload.
- Optional console/network/websocket upload failures are skipped and omitted from the manifest/index.
- Video larger than the upload threshold is split into ordered byte parts and reassembled as a single Blob in the player.
- Popup and player loading progress show aggregate bytes plus per-file progress rows.
- Upload history stores the final replay URL and Drive folder metadata locally, then syncs `gn-tracing-upload-history.json` for each configured Drive target folder when auth is available.

## 5. Related Docs

- [Drive And Player](../../modules/drive-and-player.md)
- [Shared Data Models](../../shared/data-models.md)
- [API Conventions](../../shared/api-conventions.md)
