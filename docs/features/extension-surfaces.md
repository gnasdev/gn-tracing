---
title: "Extension Surfaces"
description: "Current popup, settings, auth, and upload-history page behavior for GN Tracing."
type: feature
status: implemented
tags: ["popup", "settings", "history", "auth", "cloud-storage"]
source_paths:
  - "src/popup/popup.ts"
  - "src/shared/feedback.ts"
  - "src/background/feedback-submit.ts"
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
- Tuân thủ: Chrome Web Store submission disclosure for recording controls and cloud storage connection
- Links: [Recording Runtime](../modules/recording-runtime.md), [Cloud Storage And Player](../modules/drive-and-player.md), [Privacy And Redaction](../modules/privacy-and-redaction.md), [Shared Data Models](../shared/data-models.md)

## Overview

The extension UI surfaces are intentionally thin. They render service-worker-owned state, send commands through runtime messages, and keep only local DOM concerns such as timers, toasts, and optimistic history-row animation.

Durable recording truth stays in the service worker because popup windows can close at any time. Upload settings and upload history are stored through the service worker, not by directly mutating shared state from a UI page.

## Popup

The popup is the quick recording surface. It:

- shows **Cloud storage** status for the active provider (Google Drive or Dropbox)
- revalidates connection state on open using per-provider mirrored connection keys when available
- hides capture controls and the pending capture queue until the active storage provider is connected
- checks whether the active tab is recordable before enabling start
- sends start, stop, remove, upload, delete-session, storage connect/disconnect, and upload-history delete commands to the service worker
- uses generic `STORAGE_CONNECT` / disconnect paths (Dropbox uses `launchWebAuthFlow`; Google may open the Drive auth page)
- renders live recording timer, console/network counts, upload progress, per-artifact progress rows, latest local upload history, and an opt-in **Feedback** button in the topbar
- Feedback opens a popover form (not a footer panel): the user submits a message and the service worker POSTs to the Worker `/feedback` route to create a public GitHub issue (light diagnostics only: extension version, browser, OS, locale). Settings, History, Manage clouds, and the extension player expose the same topbar Feedback control. GitHub repo/Contribute deep-links are not shown on extension UI surfaces

Stop is presented as "Stop & Upload" because a valid token for the active provider can auto-start upload after capture finalization.

### Loading, busy, and empty feedback

- **Stop & Upload**: `.btn-spinner` + `aria-busy` via shared `buttonSpinnerHtml` / stop loading path.
- **Start while tab-check is in flight**: Start button shows spinner, `aria-busy`, and stays disabled until the active-tab check finishes.
- **Upload queue**: determinate segmented bars with `role="progressbar"` and live `aria-valuenow`; the queue section stays **hidden when empty** (no empty-card in the compact popup).
- **Upload history**: shared empty card via `upload-history-ui` (`.history-empty`).
- **Feedback submit** (popup and other surfaces using `feedback-ui`): spinner + `aria-busy` on Submit while the Worker request is in flight.
- **storage-auth**: busy provider status shows spinner + “Working…”; connect/disconnect buttons disable while that provider is busy.
- **Annotate**: save button uses shared button-loading spinner; empty shape list copy is EN/VI.

Shared primitives live in `shared/theme.css` (`.btn-spinner`, `.btn.is-loading`, empty cards) and `src/shared/button-loading.ts`.

Capture disclosure copy refers to cloud storage generically (Google Drive or Dropbox). Capture detail and password options live in Settings.

## Settings Page

The Settings page owns configuration that should not crowd the popup:

- **Storage provider** select: Google Drive, Dropbox
- Upload folder input for the active provider:
  - Google Drive: root, `/folder/path`, raw folder id, Drive folder URL, or query-string id
  - Dropbox: path (e.g. `/gn-tracing`) or blank for root
- optional ZIP password configuration and clear-password flow
- capture profiles: `lean`, `balanced`, `full`, and `custom`
- privacy profiles: `standard`, `strict`, and `custom`
- advanced console, network, response-body, redirect, initiator, WebSocket, byte-limit, and recorder-internal-request controls
- DOM masking selectors
- English/Vietnamese labels and tester-oriented help dialogs for capture fields

Capture profile and privacy profile are separate. Preset capture profiles update evidence depth, while privacy profiles update redaction behavior. Folder hints and placeholders update when the storage provider changes.

## Google Drive Auth Page

The Drive auth page is a normal extension tab so **Google** OAuth is not interrupted by popup teardown. It shows initial, loading, success, and error states, can switch English/Vietnamese text, and reacts to service-worker session-state changes. Wording on this page remains Google Drive-specific because the surface is Drive-only.

Chrome uses `chrome.identity.getAuthToken()`. Other Chromium browsers use `launchWebAuthFlow` and a locally stored token cache (with refresh when available) behind the same service-worker-facing API. Dropbox connect flows are initiated from the popup / connect page without this HTML page.

## Upload History Page

Upload history is local-only extension data. It is not written to cloud storage and is not embedded in replay packages. Entries may record which provider produced the replay link.

The popup shows only the latest visible upload, while the full History page renders the complete locally stored list. Both surfaces share `src/shared/upload-history-ui.ts` so replay, copy-link, open-folder, and delete-history actions use the same markup and action routing.

## State Ownership

Popup and Settings never own durable recording truth. The service worker owns session phase, upload progress, and auth caches. Surfaces read snapshots from `chrome.storage.session` / settings store commands and re-sync on open.
