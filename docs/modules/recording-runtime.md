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
related:
  - "./drive-and-player.md"
  - "../shared/data-models.md"
  - "../shared/api-conventions.md"
---

# Recording Runtime

## Meta

- Trạng thái: active
- Phạm vi: recording lifecycle, CDP capture, offscreen media capture, service-worker state, and popup state rendering
- Nguồn code: `src/background/service-worker.ts`, `src/background/recorder-manager.ts`, `src/background/cdp-manager.ts`, `src/background/storage-manager.ts`, `src/offscreen/offscreen.ts`, `src/popup/popup.ts`
- Tuân thủ: Documented
- Links: [Drive And Player](./drive-and-player.md), [Shared Data Models](../shared/data-models.md), [API Conventions](../shared/api-conventions.md)

## 1. Overview

This module covers the runtime capture path implemented by:
- `src/background/service-worker.ts`
- `src/background/recorder-manager.ts`
- `src/background/cdp-manager.ts`
- `src/background/storage-manager.ts`
- `src/offscreen/offscreen.ts`
- `src/popup/popup.ts`

The service worker is the orchestration boundary. It owns session state, starts/stops capture, keeps the worker alive during recording, and exposes synchronized status to UI surfaces through `chrome.storage.session`.

## 2. Functional & Non-Functional Requirements

- Start recording only when no active recording exists.
- Reject `chrome://` tabs.
- Capture media, console logs, network traffic, and WebSocket frames for the same tab session.
- Support pause/resume during capture and compute recording duration excluding paused intervals.
- Preserve popup UX even when the popup closes by mirroring state into session storage.
- Hide capture controls and the capture queue from the popup until Google Drive is connected.
- Tolerate partial teardown failures by settling recorder/CDP shutdown independently.

## 3. Data Models & APIs

- consumes `MessageAction.START_RECORDING`, `STOP_RECORDING`, `PAUSE_RECORDING`, `RESUME_RECORDING`, `REMOVE_RECORDING`, `DELETE_SESSION`, `GET_STATUS`, `GET_UPLOAD_STATE`
- persists mirrored UI state under `gn_tracing_state`
- models the active lifecycle with `RecordingPhase` values `idle`, `recording`, `paused`, and `interrupted`
- models completed local/upload sessions with `RecordingSessionSummary` values `recorded`, `uploading`, `uploaded`, and `failed`
- uses `StorageManager` as the in-memory sink for console/network/WebSocket entries

## 4. Business Rules

- `START_RECORDING` clears prior captured data before a new session begins.
- `PAUSE_RECORDING` and `RESUME_RECORDING` are delegated to the offscreen document so `MediaRecorder` state and elapsed-time accounting stay aligned.
- service worker marks the extension badge with `REC` while recording is active.
- `chrome.alarms` keepalive is created at 0.4 minutes and cleared after stop.
- source maps are flushed before debugger detach, then applied to stored console/network initiator data, and the resolver cache is released immediately after enrichment completes.
- if the recorded tab closes, the service worker attempts an automatic stop and falls back to a forced state reset on error.
- offscreen stop waits on a recording-complete signal with a 3 second safety timeout.
- large console payloads are truncated to 32 KB per entry before storage.
- successful Google Drive upload is treated as the end of the in-memory artifact lifecycle: service worker capture buffers are cleared and the offscreen recorded video blob is released, while upload result state remains available for popup UX.
- stopping a finished capture can auto-start upload when Google Drive is already connected, while the completed session remains removable from popup/history state.
- popup capture controls are gated by the cached Google Drive auth state; service worker upload commands still validate a live Drive token before uploading.

## 5. Constraints & Assumptions

- captured artifacts are memory-resident only until they are consumed by the current session flow; there is no IndexedDB or file-system persistence in the extension runtime.
- offscreen audio is looped back to the user through an `AudioContext` so tab audio remains audible during capture.
- `MediaRecorder` uses VP9+Opus when supported, otherwise VP8+Opus.
- request/response body capture is best-effort and subject to CDP availability plus body size/type rules in the implementation.

## 6. Relationships

- provides captured artifacts to `drive-and-player`
- consumes shared message/data models from `shared/data-models`
- depends on Chrome extension platform APIs and Google-auth-aware upload orchestration from the Drive module
- emits state changes to popup and auth page through `chrome.storage.session`

## 7. Related Decisions

- MV3 media capture is offloaded to an offscreen document instead of the service worker.
- UI clients are intentionally thin and state is centralized in the service worker.
