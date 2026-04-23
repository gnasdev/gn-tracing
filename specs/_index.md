# Specs Index

## Core Docs

- [overview.md](./overview.md)
- [shared/project-context.md](./shared/project-context.md)
- [shared/data-models.md](./shared/data-models.md)
- [shared/api-conventions.md](./shared/api-conventions.md)
- [modules/recording-runtime.md](./modules/recording-runtime.md)
- [modules/drive-and-player.md](./modules/drive-and-player.md)
- [compliance/_summary.md](./compliance/_summary.md)
- [_sync.md](./_sync.md)

## Dependency Map

- `recording-runtime`
  reads: `shared/data-models`, `shared/api-conventions`
  calls: `drive-and-player` for auth token lookup, Drive folder upload, and replay link generation during upload completion
- `drive-and-player`
  reads: `shared/data-models`, `shared/api-conventions`
  consumes: recording artifacts emitted by `recording-runtime`
- `shared/data-models`
  shared by: service worker, popup, offscreen uploader, built-in player, standalone player

## Runtime Topology

- `popup` -> `service-worker`: start/stop recording, upload, auth status
- `service-worker` -> `cdp-manager`: console/network/WebSocket capture
- `service-worker` -> `recorder-manager` -> `offscreen`: tab media recording lifecycle
- `service-worker` -> `chrome.storage.session`: state fan-out to popup and auth page
- `offscreen` -> Google Drive APIs: recording-folder creation, multipart uploads, chunked video upload, and sharing permissions
- `offscreen` -> Cloudflare Pages standalone player URL generation with direct artifact file ID query params (`videos`, `metadata`, optional `console`, `network`, `websocket`)
- `standalone player` -> same-origin `/api/drive?id=<file-id>` proxy for Drive artifact fetches during replay
- `release workflow` -> root `package.json` scripts plus `player-standalone/deploy.sh`: extension build, player sync/build, Cloudflare Pages deploy, and extension artifact packaging
