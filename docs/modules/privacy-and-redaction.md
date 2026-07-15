---
title: "Privacy And Redaction"
description: "Current privacy profiles, redaction policy, page-event sanitization, and replay privacy metadata."
type: module
status: active
tags: ["privacy", "redaction", "recording"]
source_paths:
  - "src/shared/privacy-redaction.ts"
  - "src/content/recording-events.ts"
  - "src/background/service-worker.ts"
  - "src/background/cdp-manager.ts"
  - "src/background/storage-manager.ts"
  - "src/settings/settings.ts"
  - "src/types/recording.ts"
related:
  - "./recording-runtime.md"
  - "./replay-player.md"
  - "../features/extension-surfaces.md"
  - "../shared/data-models.md"
  - "../compliance/privacy-policy.md"
---

# Privacy And Redaction

## Meta

- Trạng thái: active
- Phạm vi: privacy profiles, redaction rules, event sanitization, DOM masking, privacy artifact metadata, and replay privacy boundaries
- Nguồn code: `src/shared/privacy-redaction.ts`, `src/content/recording-events.ts`, `src/background/service-worker.ts`, `src/background/cdp-manager.ts`, `src/background/storage-manager.ts`, `src/settings/settings.ts`, `src/types/recording.ts`
- Tuân thủ: Google API Limited Use, Chrome Web Store data-use disclosure
- Links: [Recording Runtime](./recording-runtime.md), [Replay Player](./replay-player.md), [Extension Surfaces](../features/extension-surfaces.md), [Shared Data Models](../shared/data-models.md), [Privacy Policy](../compliance/privacy-policy.md)

## Overview

Privacy is a shared runtime policy, not only a Settings page concern. GN Tracing can capture detailed debugging evidence, but supported text/JSON evidence is passed through a versioned client-side redaction policy before it becomes replay artifacts.

The current policy version is `1`. It is implemented without Chrome API dependencies so the service worker, CDP collector, storage buffer, injected event collector, Settings UI, and future tests can use the same rules and profile defaults.

## Profiles And Settings

- `standard` enables credential-focused redaction for headers, query params, request/response bodies, console values, WebSocket text payloads, report metadata, event metadata, and DOM mask selector normalization.
- `strict` keeps the standard protections and also redacts additional personal, location, and opaque-id patterns where supported.
- `custom` starts from the protected defaults and lets the user adjust individual switches in Settings.

Capture depth and privacy profile are separate choices. A user can keep full debug capture enabled while still applying standard, strict, or custom redaction before artifacts are uploaded.

Storage and DOM capture are privacy-first opt-ins. `captureStorage` and `captureDomSnapshots` default off; their redaction companions `redactStorageValues` and `redactDomTextContent` default on. The `captureMode` setting (`"cdp"` default, `"in-page"` opt-in) does not change redaction, but `"in-page"` records additional fidelity limitations in `privacy.json`.

## Redaction Surfaces

The shared policy redacts or transforms:

- sensitive request/response header values
- URL usernames, passwords, and sensitive query parameters
- JSON, form-url-encoded, and plain-text body fields
- console messages, remote-object values, object previews, stack URLs, original source URLs, and strict-mode source snippets
- WebSocket text payloads, either by sensitive fields or by replacing all payload text
- report metadata text and page URLs
- event timeline selectors, labels, navigation URLs, and titles
- storage snapshot values and cookie values whose key matches a sensitive pattern, under the `"storage"` redaction artifact (when `redactStorageValues` is on)
- DOM snapshot text and attribute values for nodes matching the DOM mask selectors, under the `"dom"` redaction artifact (when `redactDomTextContent` is on)

Redaction hits store only metadata: artifact class, data class, action, sanitized field path, and rule id. Raw secret values are not written into `privacy.json`.

## Event Timeline And Visual Masking

The page event collector is injected only after the user starts a recording. It records sanitized navigation, click, contextmenu, scroll, focus, submit, and named-key/shortcut summaries for the active session, then removes listeners when recording stops, is removed, or a new session replaces it in the same page context.

The collector deliberately avoids raw typed input. Keyboard capture records only named keys and shortcuts (for example `Enter`, `Esc`, `Ctrl+S`), never character-by-character form or password typing. Form and sensitive targets are label-limited, and event strings are bounded before they cross back to the service worker.

DOM masking is best-effort. The configured selectors are normalized and validated in the page context, then a temporary style element blurs matching content during capture. Invalid selectors, injection failures, closed shadow DOM, canvas/video pixels, and pixels outside matched elements are represented as limitations in the privacy summary when known.

## Privacy Artifact

`privacy.json` records:

- policy version and selected privacy profile
- artifact flags for video, screenshot, report, events, console, network, WebSocket, request/response bodies, WebSocket payloads, source snippets, storage, and DOM snapshots
- grouped redaction counts, including `storage` and `dom` hits
- bounded known limitations, including storage/DOM capture failures, skipped oversized DOM snapshots, and `in-page` capture-mode fidelity limits

The privacy artifact is optional for replay compatibility. Packages without it still load through the legacy player path; packages with it render a compact privacy summary in the replay report panel.

## Boundaries

- ZIP passwords are not part of the redaction policy. Passwords protect recording package entry payloads and are kept out of replay URLs, upload history, package metadata, popup snapshots, and page-injected scripts.
- Redaction does not inspect binary/base64 response bodies or binary WebSocket payloads.
- Source-map enrichment happens before replay. The player renders enriched frames, snippets, and diagnostics from artifacts; it does not fetch original source maps or application source files during replay.
- Google Drive link sharing is not access-controlled by redaction. Unprotected replay package contents are readable to anyone with the replay URL.

## Relationships

- `recording-runtime` applies the privacy policy while collecting CDP data, page events, reports, screenshots, source-map diagnostics, and final artifacts.
- `replay-player` renders privacy summaries, redacted source locations, redacted snippets, and optional privacy limitations.
- `extension-surfaces` owns the user controls for privacy profile, custom redaction switches, DOM mask selectors, and ZIP password configuration.
