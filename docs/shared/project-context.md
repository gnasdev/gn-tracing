---
title: "Project Context"
description: "Shared product and architectural context for GN Tracing."
type: shared
status: active
tags: ["context", "architecture"]
related:
  - "../overview.md"
  - "../modules/recording-runtime.md"
  - "../modules/drive-and-player.md"
  - "../modules/privacy-and-redaction.md"
  - "../modules/replay-player.md"
  - "../features/extension-surfaces.md"
---

# Project Context

## Meta

- Trạng thái: active
- Phạm vi: product context, architectural shape, comment convention, and non-functional constraints
- Nguồn code: `src/`, `player/`
- Tuân thủ: Không áp dụng
- Links: [Overview](../overview.md), [Recording Runtime](../modules/recording-runtime.md), [Cloud Storage And Player](../modules/drive-and-player.md), [Privacy And Redaction](../modules/privacy-and-redaction.md), [Replay Player](../modules/replay-player.md), [Extension Surfaces](../features/extension-surfaces.md)

## Product Context

GN Tracing is designed for debugging and replaying real tab sessions without a first-party recording backend. The extension collects runtime evidence directly from the active tab, then packages that evidence into a zip on the user's chosen cloud storage (Google Drive or Dropbox) plus a namespaced player URL.

## Architectural Shape

- MV3 extension with a service worker as the orchestration boundary
- offscreen document for `MediaRecorder` because MV3 service workers cannot hold media capture directly
- popup and auth page as thin UI clients driven by service-worker-owned state
- Settings and full History pages as extension UI surfaces over service-worker settings/history contracts
- storage provider registry with Google Drive and Dropbox adapters
- injected content script as a recording-scoped collector for sanitized user-event summaries and visual masking only
- shared privacy/redaction policy applied before supported text/JSON evidence becomes replay artifacts
- standalone player kept separate from extension packaging, but fed by the same uploaded artifacts via per-provider proxies

## Domain Reader Model

Read the project as a capture-to-replay pipeline:

1. `extension-surfaces` lets the user choose a storage provider, connect cloud storage, configure capture/privacy settings, start/stop recording, inspect pending uploads, and open local upload history.
2. `recording-runtime` owns the active session, target validation, CDP collection, offscreen media capture, event collection, source-map enrichment, and temporary artifact lifecycle.
3. `privacy-and-redaction` defines how supported evidence is sanitized and summarized before upload.
4. `drive-and-player` owns multi-cloud auth, folder resolution, zip package upload, link sharing, and namespaced replay URL generation.
5. `replay-player` loads the package, unlocks protected zips when needed, and presents synchronized video plus debugging evidence.
6. `shared/data-models` and `shared/api-conventions` are the contracts that keep those boundaries aligned.

## Code Comment Convention

Source comments are written in English so runtime decisions, browser constraints, and shared data contracts remain readable across the whole codebase. Comments focus on why a boundary or lifecycle choice exists, especially around MV3 service-worker restarts, offscreen capture ownership, Chrome Debugger Protocol event ordering, multi-cloud upload artifacts, player loading, and release packaging.

## Non-Functional Constraints

- recording state is ephemeral and memory-backed
- service worker dormancy is mitigated with a `chrome.alarms` keepalive
- upload success depends on the active provider OAuth token and publicly shareable file permissions
- optional ZIP passwords protect package contents, not cloud file discoverability
- external player hosting is fixed to `https://tracing.gnas.dev/`
- standalone replay depends on same-origin Cloudflare Pages proxies (`/api/drive`, `/api/dropbox`) when no extension OAuth token is available
- product is telemetry-free: no logging of OAuth tokens or package bodies to remote analytics
