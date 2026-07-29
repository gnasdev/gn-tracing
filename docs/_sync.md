---
title: "Docs Sync State"
description: "Current synchronization state for the GN Tracing docs tree."
type: sync
status: active
tags: ["docs", "sync"]
---

# Docs Sync State

## Meta

- Synced commit: working tree after multi-cloud P3 compliance polish
- Synced at: `2026-07-24`
- Scope: multi-cloud storage (Google Drive + Dropbox), overview reader journey, runtime topology, recording lifecycle, privacy/redaction policy, replay player internals, extension UI surfaces, shared artifact taxonomy, API boundaries, release/update links, compliance coverage, DEVELOPER OAuth setup, and developer tooling validation
- Status: synced for multi-cloud P0–P3 product docs
- Known unsynced: build-from-scratch tutorial steps may still emphasize Google-first local smoke; refresh when rewriting that path end-to-end.

## Current Snapshot

GN Tracing is documented as a Chrome/Edge Manifest V3 extension that records one user-selected tab, captures synchronized debugging evidence, uploads one zip package to the user's chosen cloud storage (Google Drive or Dropbox), and opens a hosted replay at namespaced URLs such as `https://tracing.gnas.dev/gdrive|dropbox/<id>` (legacy Google bare ids remain parseable).

The docs give new readers an aspect-based path through the project: product purpose, MV3 runtime topology, shared data contracts, recording lifecycle, evidence artifacts, privacy/redaction, multi-cloud upload/package security, replay player behavior, extension UI surfaces, release packaging, and compliance notes.

Runtime capture is centered on the service worker, `CdpManager`, `StorageManager`, the offscreen media/upload worker, storage provider registry, and a recording-scoped content script. Captured evidence remains temporary until upload succeeds or the session is removed. Restart recovery is best-effort because heavy artifacts are memory/offscreen-backed rather than a durable local database.

Replay storage is package-scoped. Each upload writes one `gn-tracing-*.zip` into the configured cloud folder for the active provider. The zip contains `recording-index.json`, `manifest.json`, `metadata.json`, ordered `video.part-XXX.webm` entries, and optional console, network, WebSocket, report, events, privacy, diagnostics, and screenshot artifacts. JSON/text entries can use ZIP DEFLATE when useful; media/image entries stay stored. Optional ZIP passwords protect package entry payloads, not cloud file discoverability. Public share creation hard-fails the upload if it cannot complete.

Privacy is documented as a shared policy with standard, strict, and custom profiles. Supported evidence is redacted client-side across headers, URLs, JSON/form/plain-text bodies, console values, WebSocket text payloads, report metadata, event metadata, and strict-mode source snippets. Redaction counts and limitations are recorded without raw secret values.

Source-map enrichment is documented as a capture-stop operation. Inline maps and external maps loaded through CDP can enrich console, network initiator, and parsed Error object stack frames. Replay renders resolved locations, bounded source snippets, per-frame unresolved status, and optional diagnostics; it does not fetch source maps or application source files during replay.

The replay player is documented as a shared extension/standalone runtime. Extension replay can use an in-memory OAuth token for the package's provider. Standalone replay uses Cloudflare Pages proxies `/api/drive` and `/api/dropbox` (SSRF-hardened; rejects HTML interstitials as non-cacheable errors).

Extension surfaces are documented as thin clients over service-worker state. Popup controls are gated by active cloud storage connection and active-tab recordability. Popup owns storage provider, upload folder, ZIP password, and connect/manage clouds. Settings owns redaction toggles, DOM masking, capture mode (default CDP), and advanced capture controls (no capture/privacy profile presets). The Google Drive auth page protects Drive OAuth from popup teardown; Dropbox connects via popup web auth flow. Upload history is local-only and not written to cloud storage.

Compliance docs and public legal HTML (`privacy`, `terms`, `/app/` homepage) disclose multi-cloud OAuth, user-owned storage, public-by-link sharing, zip passwords, local tokens, and no product telemetry of tokens/package bodies. Multi-issuer OAuth Worker is optional for Google and Dropbox secrets.

Developer tooling is documented as a split validation path: Biome owns formatting, linting, and import organization for supported source types, while Markdown docs are checked by `npm run docs:check` for LF/final-newline hygiene, trailing whitespace, and relative Markdown link targets. `format:check`, `check`, `check:write`, Task aliases, and the Husky pre-commit hook run that docs check so `docs/` is not silently skipped by repository validation.
