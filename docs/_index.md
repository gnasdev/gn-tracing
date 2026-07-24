---
title: "Docs Index"
description: "Navigation map for the GN Tracing knowledge base."
type: index
status: active
tags: ["docs", "index"]
related:
  - "./overview.md"
  - "./_sync.md"
  - "./modules/privacy-and-redaction.md"
  - "./modules/replay-player.md"
  - "./features/extension-surfaces.md"
---

# Docs Index

## Core Docs

- [README.md](./README.md)
- [overview.md](./overview.md)
- [build-from-scratch/README.md](./build-from-scratch/README.md) — step-by-step build-from-scratch guide (extension + player + Worker).
- [shared/project-context.md](./shared/project-context.md)
- [shared/data-models.md](./shared/data-models.md)
- [shared/api-conventions.md](./shared/api-conventions.md)
- [modules/recording-runtime.md](./modules/recording-runtime.md)
- [modules/drive-and-player.md](./modules/drive-and-player.md) — multi-cloud storage (Drive + Dropbox) and player integration
- [modules/oauth-token-proxy.md](./modules/oauth-token-proxy.md) — multi-issuer OAuth token Worker (Google + Dropbox)
- [modules/privacy-and-redaction.md](./modules/privacy-and-redaction.md)
- [modules/replay-player.md](./modules/replay-player.md)
- [features/extension-surfaces.md](./features/extension-surfaces.md)
- [features/release-and-update-checks.md](./features/release-and-update-checks.md)
- [compliance/_summary.md](./compliance/_summary.md)
- [compliance/privacy-policy.md](./compliance/privacy-policy.md)
- [compliance/terms-of-service.md](./compliance/terms-of-service.md)
- [compliance/chrome-web-store-submission.md](./compliance/chrome-web-store-submission.md)
- [_sync.md](./_sync.md)

## Planning Docs

- [specs/planning/domain-project-aspects.md](./specs/planning/domain-project-aspects.md)
- [specs/planning/multi-cloud-storage-providers.md](./specs/planning/multi-cloud-storage-providers.md) — P0–P3 multi-cloud plan (implemented)

## Dependency Map

- `recording-runtime`
  reads: `shared/data-models`, `shared/api-conventions`, `privacy-and-redaction`, `extension-surfaces`
  calls: `drive-and-player` for storage token lookup, cloud zip package upload, and replay link generation during upload completion
- `drive-and-player`
  reads: `shared/data-models`, `shared/api-conventions`, `replay-player`, `privacy-and-redaction`
  consumes: recording artifacts emitted by `recording-runtime`
  owns: Google Drive and Dropbox adapters, namespaced replay URLs, hard-fail public share
- `oauth-token-proxy`
  reads: `drive-and-player`, `shared/api-conventions`
  holds: Google and Dropbox OAuth `client_secret` values in a Cloudflare Worker and proxies token exchange when a confidential client requires a secret
- `privacy-and-redaction`
  shared by: service worker, CDP collector, storage manager, content script, Settings, replay player, compliance docs
- `replay-player`
  consumes: zip package artifacts, source-map-enriched console/network data, privacy summaries, report/events/screenshot artifacts, and provider-aware proxy downloads
- `extension-surfaces`
  reads: `shared/data-models`, `recording-runtime`, `drive-and-player`, `privacy-and-redaction`
  owns: popup commands, Settings controls (storage provider + folder), auth page state, and local upload-history rendering
- `shared/data-models`
  shared by: service worker, popup, offscreen uploader, built-in player, standalone player
- `release-and-update-checks`
  reads: `drive-and-player`, `shared/api-conventions`, `compliance/chrome-web-store-submission`
  owns: release zip packaging, Store package validation, and contribution links (no runtime update polling)
- `developer-tooling`
  reads: `DEVELOPER.md`, `Taskfile.yml`, `package.json`, `biome.json`, `knip.json`
  enforces: Biome format/lint/import checks for supported source files, docs hygiene checks for Markdown files, Task aliases, a Husky pre-commit hook over staged files, and `npm run deadcode` for unused export detection

## Reader Path

1. [overview.md](./overview.md)
2. [shared/project-context.md](./shared/project-context.md)
3. [shared/data-models.md](./shared/data-models.md)
4. [modules/recording-runtime.md](./modules/recording-runtime.md)
5. [modules/privacy-and-redaction.md](./modules/privacy-and-redaction.md)
6. [modules/drive-and-player.md](./modules/drive-and-player.md)
7. [modules/replay-player.md](./modules/replay-player.md)
8. [features/extension-surfaces.md](./features/extension-surfaces.md)
9. [features/release-and-update-checks.md](./features/release-and-update-checks.md)
10. [compliance/_summary.md](./compliance/_summary.md)

## Runtime Topology

- `popup` -> `service-worker`: start/stop recording, upload, storage auth status
- `service-worker` (composition root) -> `settings-store`, `capture-environment`, `upload-orchestrator`, `message-router`
- `service-worker` -> `cdp-manager`: console/network/WebSocket capture
- `service-worker` -> `recorder-manager` -> `offscreen`: tab media recording lifecycle
- `service-worker` -> storage provider registry + per-provider auth (`google-drive-auth`, `dropbox-auth`)
- `google-drive-auth` -> `oauth-token-proxy` (Cloudflare Worker) when `GOOGLE_TOKEN_PROXY_URL` is set; Dropbox uses `/token/dropbox` on the same Worker when a secret is required
- `service-worker` -> injected content script: active-tab, recording-scoped user-event collection and selector-based visual masking with safe privacy settings only
- `service-worker` -> `chrome.storage.session`: state fan-out to popup and auth page
- `offscreen` -> active cloud APIs: folder resolution/creation, compact/DEFLATE zip package creation, optional ZIP password entry protection, package upload, and public-share creation (hard-fail on share failure)
- `offscreen` -> Cloudflare Pages standalone player URL generation with namespaced recording paths (`/gdrive|dropbox/<id>`); legacy bare Google ids remain parseable
- `extension player` -> provider authenticated media download when a token is available (`GET_STORAGE_TOKEN` / legacy `GET_GOOGLE_DRIVE_TOKEN`)
- `standalone player` -> same-origin `/api/drive` or `/api/dropbox` proxy when no OAuth token is available; password-protected packages are decrypted in-browser after user unlock
- `privacy policy` -> service worker, CDP collector, storage manager, and content script: redaction, event sanitization, DOM masking limitations, and `privacy.json` summaries
- `release workflow` -> root `Taskfile.yml`: extension build, Store package checks, and zip packaging with OAuth/extension identity from repository secrets; standalone player deploy stays manual via `player-standalone/deploy.sh`
