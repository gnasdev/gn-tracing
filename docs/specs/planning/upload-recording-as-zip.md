---
title: "Upload Recording As Zip"
description: "Implemented storage contract for packaging each recording as a single Google Drive zip artifact."
type: spec
status: implemented
tags: ["replay", "google-drive", "zip-package"]
source_paths:
  - "src/offscreen/offscreen.ts"
  - "player/player.js"
  - "player-standalone/public/player.js"
related:
  - "../../modules/drive-and-player.md"
  - "../../shared/data-models.md"
---

# Upload Recording As Zip

## Tổng Quan

Each completed recording is uploaded to Google Drive as one `gn-tracing-*.zip` package. The replay URL identifies that zip file by Drive file ID, and the player downloads the package, validates it, unpacks the recording artifacts in browser memory, and then loads the existing metadata/log/video pipeline.

This makes a recording an atomic Drive artifact: one upload, one share permission, one replay URL, and one package to delete from Drive.

## Storage Contract

An unprotected package contains:

- `recording-index.json`: replay entrypoint and artifact descriptor.
- `manifest.json`: storage layout, schema, target folder, video part list, mime type, and optional artifact availability.
- `metadata.json`: page URL, title, timestamps, duration, and high-level recording details.
- optional `console.json`, `network.json`, and `websocket.json`.
- ordered `video.part-XXX.webm` files.

The zip uses a dependency-free local ZIP writer in the offscreen runtime. Entries are stored rather than compressed so the package can be produced without adding runtime dependencies to the extension.

## Upload Flow

1. The service worker gathers the completed recording snapshot and sends it to the offscreen upload worker.
2. Offscreen builds artifact blobs for metadata, manifest, recording index, optional logs, and video parts.
3. Offscreen creates one zip blob and uploads it to the configured Drive folder.
4. Drive sharing permission is created for the zip file.
5. The replay URL is generated from the zip file ID.

Video larger than the configured part size is split into ordered chunks before packaging. Upload progress is artifact-based so the UI can show stable labels and byte totals that match the recording content, not multipart HTTP overhead.

## Player Flow

The player accepts the zip file ID from the hosted path, downloads the package, detects whether the response is a zip, and parses package entries in memory. `recording-index.json` and `manifest.json` stay the source of truth for locating metadata, logs, and video parts inside the package.

Legacy direct-file query params remain supported for older replay links and debugging, but new uploads use the zip file ID path.

## Failure Modes

- Invalid ZIP signature, unsupported entry shape, missing manifest, or missing index fails the replay with a package error.
- HTML Drive download pages are rejected before JSON/ZIP parsing.
- Unknown optional artifacts are skipped only when the manifest marks them optional.
- A failed upload, folder resolution failure, zip packaging failure, or share-permission failure prevents replay URL generation.

## Validation

- Root TypeScript build/type checks cover message and upload contracts.
- Player type checks cover shared replay loader logic.
- `task player:sync` keeps `player/player.js` and `player/player.css` mirrored into standalone public assets.
