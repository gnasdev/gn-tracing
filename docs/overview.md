---
title: "GN Tracing Docs Overview"
description: "High-level scope and guardrails for the GN Tracing knowledge base."
type: architecture
status: active
tags: ["overview", "gn-tracing"]
related:
  - "./modules/recording-runtime.md"
  - "./modules/drive-and-player.md"
  - "./modules/privacy-and-redaction.md"
  - "./modules/replay-player.md"
  - "./features/extension-surfaces.md"
  - "./shared/project-context.md"
---

# GN Tracing Docs Overview

## Meta

- Trạng thái: active
- Phạm vi: product scope, documentation boundaries, and architecture guardrails
- Nguồn code: `src/`, `popup/`, `offscreen/`, `drive-auth/`, `player/`, `player-standalone/`
- Tuân thủ: Không áp dụng
- Links: [Recording Runtime](./modules/recording-runtime.md), [Drive And Player](./modules/drive-and-player.md), [Privacy And Redaction](./modules/privacy-and-redaction.md), [Replay Player](./modules/replay-player.md), [Extension Surfaces](./features/extension-surfaces.md), [Project Context](./shared/project-context.md)

## Goal

GN Tracing is a Chrome/Edge Manifest V3 extension for capturing a browser tab session as synchronized artifacts:
- tab video/audio recording
- console logs and exception traces
- network requests, responses, and WebSocket traffic
- optional Google Drive upload with a player URL for replay

## Reader Journey

A new reader should understand GN Tracing in this order:

1. Product purpose and the capture-to-replay happy path.
2. Runtime topology: service worker, offscreen document, CDP collector, injected event collector, and thin UI clients.
3. Shared data contracts: messages, recording state, settings, recording artifacts, and replay package layout.
4. Recording lifecycle and target-tab restrictions.
5. Evidence taxonomy: media, console, network, WebSocket, report, events, privacy, diagnostics, screenshot, storage, and DOM-snapshot artifacts.
6. Privacy/redaction behavior, capture-depth profiles, and the opt-in `cdp` vs `in-page` capture mode.
7. Google Drive authentication, folder targeting, package upload, and optional ZIP password semantics.
8. Replay player modes, package loading, inspection UX, and standalone Drive proxy.
9. Release packaging, Chrome Web Store disclosure, and privacy compliance.

## Runtime Topology

```mermaid
flowchart LR
  User["User starts recording"] --> Popup["Popup"]
  Popup --> ServiceWorker["Service worker"]
  ServiceWorker --> Cdp["CdpManager"]
  ServiceWorker --> Offscreen["Offscreen MediaRecorder and uploader"]
  ServiceWorker --> Events["Injected event collector"]
  Cdp --> Storage["StorageManager"]
  Events --> ServiceWorker
  Storage --> ServiceWorker
  ServiceWorker --> Offscreen
  Offscreen --> Drive["Google Drive zip package"]
  Drive --> Player["Replay player"]
  Player --> Proxy["Cloudflare Pages /api/drive proxy"]
```

## In Scope

- MV3 extension runtime under `src/`, `popup/`, `offscreen/`, `drive-auth/`, `player/`
- capture orchestration via service worker, offscreen document, and Chrome Debugger API
- Google Drive authentication and upload flow
- built-in replay player and standalone player integration under `player-standalone/`
- shared privacy/redaction policy, event timeline capture, replay report artifacts, and source-map diagnostics
- popup, Settings, auth, and upload-history extension surfaces
- build pipeline that emits the unpacked extension into `dist/`

## Out Of Scope

- backend/server-side storage or processing
- local persistence for captured recording payloads beyond in-memory runtime state
- backward compatibility with removed modules or deprecated message contracts
- non-Chromium browser implementations beyond the current Chrome/Edge-specific handling already in code

## Current Scope Guard

The current codebase is centered on session capture and replay distribution. New docs should stay within:
- browser capture/runtime behavior
- upload/share flows
- player hosting and playback integration
- privacy, redaction, evidence quality, and compliance semantics for captured artifacts
- build/distribution mechanics for the extension and standalone player
