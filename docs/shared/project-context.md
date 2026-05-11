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
---

# Project Context

## Meta

- Trạng thái: active
- Phạm vi: product context, architectural shape, comment convention, and non-functional constraints
- Nguồn code: `src/`, `player/`, `player-standalone/`
- Tuân thủ: Không áp dụng
- Links: [Overview](../overview.md), [Recording Runtime](../modules/recording-runtime.md), [Drive And Player](../modules/drive-and-player.md)

## Product Context

GN Tracing is designed for debugging and replaying real tab sessions without a backend. The extension collects runtime evidence directly from the active tab, then packages that evidence into Google Drive-hosted artifacts plus a player URL.

## Architectural Shape

- MV3 extension with a service worker as the orchestration boundary
- offscreen document for `MediaRecorder` because MV3 service workers cannot hold media capture directly
- popup and auth page as thin UI clients driven by service-worker-owned state
- standalone player kept separate from extension packaging, but fed by the same uploaded artifacts

## Code Comment Convention

Source comments are written in English so runtime decisions, browser constraints, and shared data contracts remain readable across the whole codebase. Comments focus on why a boundary or lifecycle choice exists, especially around MV3 service-worker restarts, offscreen capture ownership, Chrome Debugger Protocol event ordering, Google Drive upload artifacts, player loading, and release packaging.

## Non-Functional Constraints

- recording state is ephemeral and memory-backed
- service worker dormancy is mitigated with a `chrome.alarms` keepalive
- upload success depends on Google Drive OAuth and publicly shareable file permissions
- external player hosting is fixed to `https://tracing.gnas.dev/`
- standalone replay depends on the Cloudflare Pages `/api/drive` proxy to fetch public Drive artifacts without cross-origin download failures
