---
title: "Extension Surfaces"
description: "Current popup dialogs (settings, history, manage clouds), auth, and annotate surfaces for GN Tracing."
type: feature
status: implemented
tags: ["popup", "settings", "history", "auth", "cloud-storage"]
source_paths:
  - "src/popup/popup.ts"
  - "src/popup/dialog-host.ts"
  - "src/shared/feedback.ts"
  - "src/shared/settings-form-ui.ts"
  - "src/background/feedback-submit.ts"
  - "src/background/screenshot-report.ts"
  - "popup/popup.html"
  - "popup/popup.css"
  - "src/drive-auth/drive-auth.ts"
  - "drive-auth/drive-auth.html"
  - "src/storage-auth/storage-auth.ts"
  - "storage-auth/storage-auth.html"
  - "src/annotate/annotate.ts"
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
- Phạm vi: popup controls and dialogs (settings, history, manage clouds, Instant Replay), OAuth auth tabs, annotate editor, local history actions, and UI ownership boundaries
- Nguồn code: `src/popup/popup.ts`, `src/popup/dialog-host.ts`, `popup/`, `src/shared/settings-form-ui.ts`, `src/storage-auth/`, `src/drive-auth/`, `src/annotate/`, `src/shared/upload-history-ui.ts`
- Tuân thủ: Chrome Web Store submission disclosure for recording controls and cloud storage connection
- Links: [Recording Runtime](../modules/recording-runtime.md), [Cloud Storage And Player](../modules/drive-and-player.md), [Privacy And Redaction](../modules/privacy-and-redaction.md), [Shared Data Models](../shared/data-models.md)

## Overview

The extension UI surfaces are intentionally thin. They render service-worker-owned state, send commands through runtime messages, and keep only local DOM concerns such as timers, toasts, and optimistic history-row animation.

Durable recording truth stays in the service worker because popup windows can close at any time. Upload settings and upload history are stored through the service worker, not by directly mutating shared state from a UI page.

## Popup

The popup is the quick recording surface. It:

- shows the **Cloud storage** card: active connected provider select, upload folder path, status, and Connect/Manage clouds
- revalidates connection state on open using per-provider mirrored connection keys when available
- persists provider switch and folder edits immediately via `UPDATE_SETTINGS` (per-provider folder paths)
- also owns package zip-password controls and Instant Replay (enable toggle, lookback window, domain allowlist; capture-after-the-fact, not a Record session)
- opens **Settings**, **Upload history**, **Manage clouds**, and **Instant Replay settings** as in-popup dialogs (single-open host)
- hides capture controls and the pending capture queue until the active storage provider is connected
- checks whether the active tab is recordable before enabling start
- sends start, stop, remove, upload, delete-session, storage connect/disconnect, and upload-history delete commands to the service worker
- uses generic `STORAGE_CONNECT` / disconnect paths (Dropbox uses `launchWebAuthFlow`; Google may open the storage-auth / Drive auth tab)
- **Screenshot** and **Instant Replay** both open the annotate editor before upload; Instant Replay freezes lookback at capture time
- renders live recording timer, console/network counts, upload progress, per-artifact progress rows, upload-history entry summary, and an opt-in **Feedback** button in the topbar
- Feedback opens a popover form (not a footer panel): the user submits a message and the service worker POSTs to the Worker `/feedback` route to create a public GitHub issue (light diagnostics only: extension version, browser, OS, locale). GitHub repo/Contribute deep-links are not shown on extension UI surfaces

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

Capture disclosure copy refers to cloud storage generically (Google Drive or Dropbox). Cloud provider, upload folder, package password, connect/manage, capture detail, redaction options, Instant Replay, and upload history all live on the **popup** (dialogs for dense forms).

## Settings Dialog (popup)

Capture/privacy configuration opens from the popup gear as a dialog (not a standalone HTML page). Shared form logic lives in `src/shared/settings-form-ui.ts`. Sections:

1. **Privacy & Redaction** — per-section Save
2. **Capture** — Console / Network / WebSocket / Inspector + per-section Save
3. **Capture mode** — CDP / in-page + per-section Save

Instant Replay controls live in a separate popup dialog (enable, window, domain allowlist). After a bug, **Instant Replay** freezes lookback, opens the annotate editor, and uploads only on Save. Defaults are full capture + CDP for **Record**.

## Cloud Auth Pages

`storage-auth` is the multi-cloud OAuth tab (Google Drive / Dropbox). `drive-auth` remains a thin legacy redirect into storage-auth. These stay full pages so OAuth is not interrupted by popup teardown.

Chrome uses `chrome.identity.getAuthToken()` for Google when available. Other Chromium browsers use `launchWebAuthFlow` and a locally stored token cache behind the same service-worker-facing API.

## Upload History Dialog (popup)

Upload history is local-only extension data. It is not written to cloud storage and is not embedded in replay packages. Entries may record which provider produced the replay link.

The popup shows an entry summary on the main surface and the full list in a history dialog. Rendering/actions share `src/shared/upload-history-ui.ts`.

## State Ownership

Popup dialogs never own durable recording truth. The service worker owns session phase, upload progress, and auth caches. Surfaces read snapshots from `chrome.storage.session` / settings store commands and re-sync on open.
