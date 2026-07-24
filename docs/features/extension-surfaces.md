---
title: "Extension Surfaces"
description: "Current popup, settings, auth, and upload-history page behavior for GN Tracing."
type: feature
status: implemented
tags: ["popup", "settings", "history", "auth"]
source_paths:
  - "src/popup/popup.ts"
  - "popup/popup.html"
  - "popup/popup.css"
  - "src/settings/settings.ts"
  - "settings/settings.html"
  - "settings/settings.css"
  - "src/drive-auth/drive-auth.ts"
  - "drive-auth/drive-auth.html"
  - "src/history/history.ts"
  - "history/history.html"
  - "src/shared/upload-history-ui.ts"
related:
  - "../modules/recording-runtime.md"
  - "../modules/drive-and-player.md"
  - "../modules/privacy-and-redaction.md"
  - "../shared/data-models.md"
---

# Extension Surfaces

## Meta

- Trạng thái: implemented
- Phạm vi: popup controls, Settings page, Google Drive auth page, full upload-history page, local history actions, and UI ownership boundaries
- Nguồn code: `src/popup/popup.ts`, `popup/`, `src/settings/settings.ts`, `settings/`, `src/drive-auth/drive-auth.ts`, `drive-auth/`, `src/history/history.ts`, `history/`, `src/shared/upload-history-ui.ts`
- Tuân thủ: Chrome Web Store submission disclosure for recording controls and Google Drive connection
- Links: [Recording Runtime](../modules/recording-runtime.md), [Drive And Player](../modules/drive-and-player.md), [Privacy And Redaction](../modules/privacy-and-redaction.md), [Shared Data Models](../shared/data-models.md)

## Overview

The extension UI surfaces are intentionally thin. They render service-worker-owned state, send commands through runtime messages, and keep only local DOM concerns such as timers, toasts, and optimistic history-row animation.

Durable recording truth stays in the service worker because popup windows can close at any time. Upload settings and upload history are stored through the service worker, not by directly mutating shared state from a UI page.

## Popup

The popup is the quick recording surface. It:

- checks Google Drive status on open
- hides capture controls and the pending capture queue until Drive is connected
- checks whether the active tab is recordable before enabling start
- sends start, stop, remove, upload, delete-session, Drive connect/disconnect, and upload-history delete commands to the service worker
- renders live recording timer, console/network counts, upload progress, per-artifact progress rows, latest local upload history, and GitHub/contribution links

Stop is presented as "Stop & Upload" because a valid Drive token can auto-start upload after capture finalization.

## Settings Page

The Settings page owns configuration that should not crowd the popup:

- Drive target folder input, accepting root, `/folder/path`, raw Drive folder id, Drive folder URL, or query-string id
- optional ZIP password configuration and clear-password flow
- capture profiles: `lean`, `balanced`, `full`, and `custom`
- privacy profiles: `standard`, `strict`, and `custom`
- advanced console, network, response-body, redirect, initiator, WebSocket, byte-limit, and recorder-internal-request controls
- DOM masking selectors
- English/Vietnamese labels and tester-oriented help dialogs for capture fields

Capture profile and privacy profile are separate. Preset capture profiles update evidence depth, while privacy profiles update redaction behavior.

## Google Drive Auth Page

The Drive auth page is a normal extension tab so OAuth is not interrupted by popup teardown. It shows initial, loading, success, and error states, can switch English/Vietnamese text, and reacts to service-worker session-state changes.

Chrome uses `chrome.identity.getAuthToken()`. Edge uses `launchWebAuthFlow` and a locally stored verified access token behind the same service-worker-facing API.

## Upload History Page

Upload history is local-only extension data. It is not written to Google Drive and is not embedded in replay packages.

The popup shows only the latest visible upload, while the full History page renders the complete locally stored list. Both surfaces share `src/shared/upload-history-ui.ts` so replay, copy-link, open-folder, and delete-history actions use the same markup and action routing.

## State Ownership

- `chrome.storage.session` mirrors `PopupState` for popup/auth/history warm starts and service-worker restart recovery.
- `chrome.storage.local` stores upload settings, Edge token fallback, and local upload history.
- The plaintext ZIP password stays in local extension settings and is never exposed through popup state snapshots, upload history, replay URLs, package metadata, or page-injected scripts.
- Pending session artifacts are temporary and are cleared after successful upload or explicit removal.

## Constraints

- UI surfaces must not assume that a service worker is continuously alive.
- Capture controls must remain gated by both Google Drive connection and active-tab recordability.
- Auth status shown in the popup is cached for responsiveness but refreshed through service-worker commands.
- Upload progress UI must handle high-frequency progress updates without re-rendering unrelated popup state unnecessarily.
