---
title: "Docs Index"
description: "Navigation map for the GN Tracing knowledge base."
type: index
status: active
tags: ["docs", "index"]
related:
  - "./overview.md"
  - "./_sync.md"
---

# Docs Index

## Core Docs

- [README.md](./README.md)
- [overview.md](./overview.md)
- [shared/project-context.md](./shared/project-context.md)
- [shared/data-models.md](./shared/data-models.md)
- [shared/api-conventions.md](./shared/api-conventions.md)
- [modules/recording-runtime.md](./modules/recording-runtime.md)
- [modules/drive-and-player.md](./modules/drive-and-player.md)
- [features/release-and-update-checks.md](./features/release-and-update-checks.md)
- [compliance/_summary.md](./compliance/_summary.md)
- [compliance/privacy-policy.md](./compliance/privacy-policy.md)
- [compliance/chrome-web-store-submission.md](./compliance/chrome-web-store-submission.md)
- [specs/planning/restore-request-call-stack-sourcemap-resolution.md](./specs/planning/restore-request-call-stack-sourcemap-resolution.md)
- [specs/planning/fix-generated-only-sourcemap-replay.md](./specs/planning/fix-generated-only-sourcemap-replay.md)
- [_sync.md](./_sync.md)

## Dependency Map

- `recording-runtime`
  reads: `shared/data-models`, `shared/api-conventions`
  calls: `drive-and-player` for auth token lookup, Drive zip package upload, and replay link generation during upload completion
- `drive-and-player`
  reads: `shared/data-models`, `shared/api-conventions`
  consumes: recording artifacts emitted by `recording-runtime`
- `shared/data-models`
  shared by: service worker, popup, offscreen uploader, built-in player, standalone player
- `release-and-update-checks`
  reads: `drive-and-player`, `shared/api-conventions`, `compliance/chrome-web-store-submission`
  calls: GitHub Releases API through the service worker for version comparison and release download discovery
- `developer-tooling`
  reads: `DEVELOPER.md`, `Taskfile.yml`, `package.json`, `biome.json`
  enforces: Biome format/lint/import checks through npm scripts, Task aliases, and a Husky pre-commit hook over staged files

## Runtime Topology

- `popup` -> `service-worker`: start/stop recording, upload, auth status
- `service-worker` -> `cdp-manager`: console/network/WebSocket capture
- `service-worker` -> `recorder-manager` -> `offscreen`: tab media recording lifecycle
- `service-worker` -> injected content script: active-tab, recording-scoped user-event collection and selector-based visual masking with safe privacy settings only
- `service-worker` -> `chrome.storage.session`: state fan-out to popup and auth page
- `offscreen` -> Google Drive APIs: target-folder resolution/creation, compact/DEFLATE zip package creation, optional ZIP password entry protection, package upload, and sharing permissions
- `offscreen` -> Cloudflare Pages standalone player URL generation with one recording zip file ID path (`/<id>`)
- `extension player` -> Google Drive API `files.get?alt=media` with the current OAuth token for Drive package fetches when available
- `standalone player` -> same-origin `/api/drive?id=<file-id>` proxy for Drive package fetches when no OAuth token is available; password-protected packages are decrypted in-browser after user unlock
- `release workflow` -> root `Taskfile.yml`: extension build, Store package checks, and zip packaging with OAuth/extension identity from repository secrets; standalone player deploy stays manual via `player-standalone/deploy.sh`
- `popup update check` -> `service-worker` -> GitHub Releases API: compare installed package version against the latest release and expose a manual download path when a newer extension zip is available
