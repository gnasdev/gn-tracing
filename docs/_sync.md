---
title: "Docs Sync State"
description: "Current synchronization state for the GN Tracing docs tree."
type: sync
status: active
tags: ["docs", "sync"]
---

# Docs Sync State

## Meta

- Synced commit: `9b91168704d2847259bbf2e29643ff15b4f9ba9b` plus current docs working-tree changes
- Synced at: `2026-06-03T16:03:03+07:00`
- Scope: domain/project aspect map, overview reader journey, runtime topology, recording lifecycle, privacy/redaction policy, replay player internals, extension UI surfaces, shared artifact taxonomy, API boundaries, release/update links, and compliance coverage links
- Status: synced
- Known unsynced: None known for the documented scope.

## Current Snapshot

GN Tracing is documented as a Chrome/Edge Manifest V3 extension that records one user-selected tab, captures synchronized debugging evidence, uploads one Google Drive zip package, and opens a hosted replay at `https://tracing.gnas.dev/<zip-file-id>`.

The docs now give new readers an aspect-based path through the project: product purpose, MV3 runtime topology, shared data contracts, recording lifecycle, evidence artifacts, privacy/redaction, Drive upload/package security, replay player behavior, extension UI surfaces, release/update checks, and compliance notes.

Runtime capture is centered on the service worker, `CdpManager`, `StorageManager`, the offscreen media/upload worker, and a recording-scoped content script. Captured evidence remains temporary until upload succeeds or the session is removed. Restart recovery is best-effort because heavy artifacts are memory/offscreen-backed rather than a durable local database.

Replay storage is package-scoped. Each upload writes one `gn-tracing-*.zip` directly into the configured Drive folder. The zip contains `recording-index.json`, `manifest.json`, `metadata.json`, ordered `video.part-XXX.webm` entries, and optional console, network, WebSocket, report, events, privacy, diagnostics, and screenshot artifacts. JSON/text entries can use ZIP DEFLATE when useful; media/image entries stay stored. Optional ZIP passwords protect package entry payloads, not Drive file discoverability.

Privacy is documented as a shared policy with standard, strict, and custom profiles. Supported evidence is redacted client-side across headers, URLs, JSON/form/plain-text bodies, console values, WebSocket text payloads, report metadata, event metadata, and strict-mode source snippets. Redaction counts and limitations are recorded without raw secret values.

Source-map enrichment is documented as a capture-stop operation. Inline maps and external maps loaded through CDP can enrich console, network initiator, and parsed Error object stack frames. Replay renders resolved locations, bounded source snippets, per-frame unresolved status, and optional diagnostics; it does not fetch source maps or application source files during replay.

The replay player is documented as a shared extension/standalone runtime. Extension replay can use an in-memory Drive OAuth token. Standalone replay uses the Cloudflare Pages `/api/drive` proxy, which resolves public Drive confirmation pages and rejects unresolved HTML responses as non-cacheable errors.

Extension surfaces are documented as thin clients over service-worker state. Popup controls are gated by Drive connection and active-tab recordability. Settings owns Drive folder, ZIP password, capture profile, privacy profile, DOM masking, and advanced capture controls. The auth page protects OAuth from popup teardown. Upload history is local-only and not written to Drive.
