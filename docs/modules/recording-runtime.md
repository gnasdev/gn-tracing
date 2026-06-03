---
title: "Recording Runtime"
description: "Current MV3 recording orchestration, capture lifecycle, and popup state model."
type: module
status: active
tags: ["recording", "mv3", "runtime"]
source_paths:
  - "src/background/service-worker.ts"
  - "src/background/recorder-manager.ts"
  - "src/background/cdp-manager.ts"
  - "src/background/storage-manager.ts"
  - "src/offscreen/offscreen.ts"
  - "src/popup/popup.ts"
  - "src/settings/settings.ts"
  - "src/shared/recording-target.ts"
related:
  - "./drive-and-player.md"
  - "./privacy-and-redaction.md"
  - "./replay-player.md"
  - "../features/extension-surfaces.md"
  - "../shared/data-models.md"
  - "../shared/api-conventions.md"
---

# Recording Runtime

## Meta

- Trạng thái: active
- Phạm vi: recording lifecycle, CDP capture, offscreen media capture, service-worker state, popup state rendering, and capture settings
- Nguồn code: `src/background/service-worker.ts`, `src/background/recorder-manager.ts`, `src/background/cdp-manager.ts`, `src/background/storage-manager.ts`, `src/offscreen/offscreen.ts`, `src/popup/popup.ts`, `src/settings/settings.ts`, `src/shared/recording-target.ts`
- Tuân thủ: Không áp dụng
- Links: [Drive And Player](./drive-and-player.md), [Privacy And Redaction](./privacy-and-redaction.md), [Replay Player](./replay-player.md), [Extension Surfaces](../features/extension-surfaces.md), [Shared Data Models](../shared/data-models.md), [API Conventions](../shared/api-conventions.md)

## 1. Overview

This module covers the runtime capture path implemented by:
- `src/background/service-worker.ts`
- `src/background/recorder-manager.ts`
- `src/background/cdp-manager.ts`
- `src/background/storage-manager.ts`
- `src/offscreen/offscreen.ts`
- `src/popup/popup.ts`
- `src/settings/settings.ts`
- `src/shared/recording-target.ts`

The service worker is the orchestration boundary. It owns session state, starts/stops capture, keeps the worker alive during recording, and exposes synchronized status to UI surfaces through `chrome.storage.session`.

For a new reader, this module is the capture side of the product. It explains how a user-selected tab becomes temporary evidence artifacts. Drive upload, replay package viewing, privacy policy details, and UI-surface ownership are documented separately in [Drive And Player](./drive-and-player.md), [Replay Player](./replay-player.md), [Privacy And Redaction](./privacy-and-redaction.md), and [Extension Surfaces](../features/extension-surfaces.md).

## 1.1 Runtime Lifecycle

The primary lifecycle is:

1. Popup validates that Google Drive is connected and the active tab is recordable.
2. Service worker validates the target tab again before mutating recording state.
3. Service worker creates a session id, loads upload/capture/privacy settings, clears old in-memory capture data, configures `StorageManager` and `CdpManager`, attaches CDP, and asks `RecorderManager` to start offscreen media capture.
4. Service worker injects the recording-scoped event collector and visual masking settings into the page.
5. During recording, CDP events are stored in memory, popup state is mirrored into `chrome.storage.session`, and `chrome.alarms` keeps the MV3 worker warm.
6. Stop first tears down page-event capture and media recording, then flushes source maps while CDP is still attached, captures a best-effort visible-tab screenshot, resolves source maps into stored console/network data, and finalizes artifacts.
7. If a valid Drive token is available, upload starts automatically; otherwise the completed local session stays pending while its temporary snapshot remains available.

## 2. Functional & Non-Functional Requirements

- Start recording only when no active recording exists.
- Reject unsupported tab targets before starting capture, including browser system pages, extension pages, DevTools/internal URLs, Chrome Web Store pages, and tabs without recordable `http:`, `https:`, or `file:` URLs.
- Disable the popup start-recording button while the current active tab is not recordable, and show the same block reason the service worker would return.
- Capture media, console logs, network traffic, and WebSocket frames for the same tab session.
- Capture lightweight report metadata, browser/page environment context, a redacted user interaction timeline, and an optional visible-tab screenshot for the replay report.
- Apply a shared client-side privacy/redaction policy across headers, URLs, JSON/form bodies, console values, WebSocket text payloads, report metadata, and event metadata before artifacts are uploaded.
- Redact sensitive header values by default and capture console, network, request/response body, initiator, and WebSocket payload details according to the user's capture profile and advanced settings.
- Allow a separate privacy profile so users can capture detailed evidence while still applying standard, strict, or custom redaction rules.
- Compute recording duration as elapsed wall-clock time between start and stop.
- Preserve popup UX even when the popup closes by mirroring state into session storage.
- Hide capture controls and the capture queue from the popup until Google Drive is connected.
- Tolerate partial teardown failures by settling recorder/CDP shutdown independently.

## 3. Data Models & APIs

- consumes `MessageAction.START_RECORDING`, `STOP_RECORDING`, `REMOVE_RECORDING`, `DELETE_SESSION`, `GET_STATUS`, `GET_UPLOAD_STATE`
- persists mirrored UI state under `gn_tracing_state`
- models the active lifecycle with `RecordingPhase` values `idle`, `recording`, and `interrupted`
- models completed local/upload sessions with `RecordingSessionSummary` values `recorded`, `uploading`, `uploaded`, and `failed`
- uses `StorageManager` as the in-memory sink for console/network/WebSocket entries
- stores capture settings as part of `UploadSettings`, with profile presets and advanced controls normalized by the service worker before each recording starts
- stores privacy redaction settings as part of `UploadSettings`, with standard/strict/custom profiles, built-in rule versioning, WebSocket payload redaction mode, event/report redaction toggles, and DOM masking selectors
- accepts `RECORDING_USER_EVENT` messages from the injected page collector for navigation/click/focus/submit summaries that match the active tab and session
- emits optional replay report artifacts: `report.json`, `events.json`, `privacy.json`, `diagnostics.json`, and `screenshot.jpg`

## 3.1 Capture Evidence Boundaries

Runtime capture produces evidence, but it does not make those artifacts durable by itself:

- media is held by the offscreen document as a session snapshot until upload succeeds, the session is deleted, or extension runtime availability is lost
- console, network, WebSocket, report, event, privacy, diagnostic, and screenshot artifacts are serialized only for the current post-recording flow
- successful upload clears the in-memory service-worker capture buffers and releases the offscreen recorded video blob
- restart recovery is best-effort because heavy artifacts are memory/offscreen-backed, not a durable local database

The capture target must be a user-selected tab with an `http:`, `https:`, or `file:` URL. Browser system pages, extension pages, DevTools/internal URLs, Chrome Web Store pages, tabs without a normal URL, and unsupported URL schemes are rejected before capture starts.

## 3.2 CDP Capture Model

`CdpManager` attaches Chrome Debugger Protocol to the selected tab, enables Network, Runtime, Log, and best-effort Debugger domains, and auto-attaches child targets. It handles CDP ordering defensively because request extra-info, response bodies, redirects, early hints, cache events, target detach notifications, and WebSocket frames can arrive outside a simple request lifecycle.

Capture settings control which console, network, body, initiator, and WebSocket details are stored. Privacy settings are applied while data is collected and again when console artifacts are finalized.

## 4. Business Rules

- `START_RECORDING` clears prior captured data before a new session begins.
- `START_RECORDING` validates the target tab before changing recording state or attaching capture APIs, so unsupported tabs fail with a clear popup error instead of leaving a partial session behind.
- popup and service worker share the same target-tab validation helper so proactive button disabling and final runtime validation stay aligned.
- the user-event collector is injected only after recording starts, is re-injected after top-level navigation completes, and is asked to stop when the recording stops or is removed.
- only safe privacy settings are sent to the injected collector; plaintext zip passwords and Drive credentials never cross into the page context.
- user-event capture stores redacted selectors, short labels, roles, event types, timing, and coordinates when available; it does not store raw typed input, and form/sensitive targets are deliberately label-limited.
- selector-based visual masking applies CSS before or during capture when configured, is re-applied after navigation, and records privacy limitations when injection or selector validation fails.
- redaction hits record only counts, sanitized field paths, data classes, and rule ids; raw secret values are never written into `privacy.json`.
- stop-time screenshot capture is optional, size-limited, and non-blocking; upload/replay continue when screenshot capture is unavailable.
- service worker marks the extension badge with `REC` while recording is active.
- `chrome.alarms` keepalive is created at 0.4 minutes and cleared after stop.
- source maps are flushed before debugger detach, then applied to stored console/network initiator data. Inline `data:` maps are decoded directly; external `.map` files are loaded best-effort through target-aware CDP `Network.loadNetworkResource`/`IO.read` without page-context `fetch(...)`, and the resolver cache is released immediately after enrichment completes.
- Error remote object descriptions captured as console arguments are parsed as conservative V8 stack strings into `SerializedRemoteObject.stackTrace` when the console stack capture setting keeps that entry level, then those parsed frames go through the same stop-time source-map resolver as structured console and network stacks. The raw Error description remains available for compatibility and redaction, while replay prefers the structured stack when present.
- source-map load attempts that need a frame id can be deferred when `Debugger.scriptParsed` races ahead of `Runtime.executionContextCreated`; the runtime retries pending attempts when frame context arrives and again during flush before falling back to `missing-frame-id`.
- source-map load attempts are recorded in redacted `diagnostics.json` when available, including target type, frame id presence, load status, failure reason, HTTP status, basic map shape, and classified HTML/non-JSON responses so the player can distinguish missing maps from unresolved frames.
- generated-only console and network initiator frames can carry frame-level `sourceMapStatus` when the resolver can explain the unresolved location, including no loaded map, no generated line, no matching segment, or no original segment.
- the injected `content/recording-events.js` bundle is emitted without a `sourceMappingURL` comment so starting a recording does not cause Chrome to resolve an injected-script map through `chrome-extension://invalid/`.
- if the recorded tab closes, the service worker attempts an automatic stop and falls back to a forced state reset on error.
- offscreen stop waits on a recording-complete signal with a 3 second safety timeout.
- large console payloads are compacted and truncated according to the configured max console entry size before storage.
- successful Google Drive upload is treated as the end of the in-memory artifact lifecycle: service worker capture buffers are cleared and the offscreen recorded video blob is released, while upload result state remains available for popup UX.
- stopping a finished capture can auto-start upload when Google Drive is already connected, while the completed session remains removable from popup/history state.
- popup capture controls are gated by the cached Google Drive auth state; service worker upload commands still validate a live Drive token before uploading.
- popup keeps quick recording controls and opens a dedicated Settings page for Drive, package security, capture profiles, and advanced console/network/WebSocket controls.
- Settings UI text can switch between English and Vietnamese, and each capture field exposes a tester-oriented help dialog explaining when QC should enable, disable, or limit that evidence.
- capture profiles include lean, balanced, full debug, and custom; full debug is the default, and profile selection expands into concrete settings so the runtime does not infer behavior from UI labels.
- CDP collection applies capture settings before storing artifacts: disabled console/network/WebSocket groups are skipped, disabled bodies are not fetched, WebSocket payloads can be redacted or size-limited, blank byte-limit fields mean no limit, and network headers/initiators can be reduced.
- CDP collection applies shared redaction before storage: header values, query params, request/response body fields, WebSocket payloads, initiator URLs, redirect URLs, and parsed Error stack frame locations go through the active privacy policy.

## 5. Constraints & Assumptions

- captured artifacts are memory-resident only until they are consumed by the current session flow; there is no IndexedDB or file-system persistence in the extension runtime.
- offscreen audio is looped back to the user through an `AudioContext` so tab audio remains audible during capture.
- `MediaRecorder` uses VP9+Opus when supported, otherwise VP8+Opus.
- request/response body capture is configurable, best-effort, and subject to CDP availability plus body size/type settings.
- sensitive headers are redacted by header-name pattern before network entries are serialized for upload/replay.
- source previews depend on acquired sourcemaps carrying `sourcesContent`; recordings fall back to generated file/line labels plus frame-level source-map status when a map is missing, CDP cannot load it, the map response is HTML/non-JSON, or no mapping segment matches, and snippet retention follows the configured console source-snippet mode.
- event capture is best-effort across page navigations and depends on the page accepting a temporary injected script under the active-tab permission grant.
- screenshot capture is limited to the visible tab viewport, not a full-page or desktop capture.
- field-level redaction does not inspect binary/base64 response bodies or binary WebSocket payloads; those limitations are surfaced in `privacy.json`.
- selector-based masking does not cover canvas, video, closed shadow DOM, or pixels drawn outside matched elements.

## 6. Relationships

- provides captured artifacts, report metadata, event timeline entries, privacy summaries, diagnostics, and optional screenshot data to `drive-and-player` and `replay-player`
- consumes `privacy-and-redaction` for privacy profile defaults, redaction, event sanitization, DOM masking selectors, and privacy summary construction
- receives commands and renders state through `extension-surfaces`
- consumes shared message/data models from `shared/data-models`
- depends on Chrome extension platform APIs and Google-auth-aware upload orchestration from the Drive module
- emits state changes to popup, settings, and auth pages through `chrome.storage.session`

## 7. Related Decisions

- MV3 media capture is offloaded to an offscreen document instead of the service worker.
- UI clients are intentionally thin and state is centralized in the service worker.
