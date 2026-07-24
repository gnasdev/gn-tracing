---
title: "Chrome Web Store Submission Notes"
description: "Store listing, permission, data usage, remote code, and reviewer instruction notes for GN Tracing."
type: compliance
status: active
tags: ["chrome-web-store", "permissions", "privacy"]
related:
  - "./privacy-policy.md"
  - "../modules/recording-runtime.md"
  - "../modules/drive-and-player.md"
  - "../modules/privacy-and-redaction.md"
  - "../modules/replay-player.md"
  - "../features/extension-surfaces.md"
  - "../shared/api-conventions.md"
---

# Chrome Web Store Submission Notes

## Meta

- Trạng thái: active
- Phạm vi: Chrome Web Store listing, permission, data-use, remote-code, and reviewer submission notes
- Nguồn code: `manifest.template.json`, `Taskfile.yml`, `scripts/check-store-package.mjs`, `scripts/chrome-webstore.mjs`
- Tuân thủ: Chrome Web Store submission
- Links: [Privacy Policy](./privacy-policy.md), [Recording Runtime](../modules/recording-runtime.md), [Drive And Player](../modules/drive-and-player.md), [Privacy And Redaction](../modules/privacy-and-redaction.md), [Replay Player](../modules/replay-player.md), [Extension Surfaces](../features/extension-surfaces.md), [API Conventions](../shared/api-conventions.md)

This document is the working checklist for submitting GN Tracing to the Chrome Web Store.

## Single Purpose

GN Tracing records a user-selected browser tab and packages the video, console logs, network activity, and optional WebSocket/body payload details into a shareable debugging replay.

## Permission Justifications

`tabCapture` is required to record video and audio from the active tab selected by the user.

`offscreen` is required because Manifest V3 service workers cannot own long-running `MediaRecorder` capture and upload work directly.

`debugger` is required to attach Chrome Debugger Protocol to the selected tab during an active recording. GN Tracing uses CDP to collect console logs, runtime exceptions, network metadata, request/response headers, optional request/response bodies, and WebSocket activity. The extension attaches only after the user starts recording and detaches when recording stops or the tab closes.

`activeTab` is required so the popup can identify the active tab the user chose to record.

`storage` is required to store popup state, upload settings, pending session summaries, local upload history, and temporary recording artifacts before upload.

`alarms` is required to keep the Manifest V3 service worker awake while a recording is active.

`identity` is required for Google Drive OAuth sign-in and token management.

GN Tracing does not request broad `<all_urls>` host access. Recording uses the user-selected active tab plus `debugger` and `tabCapture`. Fixed `host_permissions` are limited to:

- `https://oauth2.googleapis.com/` and `https://www.googleapis.com/` — OAuth token exchange/refresh and Google Drive API
- the configured OAuth token proxy Worker origin (when `GOOGLE_TOKEN_PROXY_URL` is set) — server-side token exchange for Web application OAuth clients

## Data Usage Answers

GN Tracing collects web browsing activity for the tab the user records. This includes URL, video/audio, console logs, runtime errors, network request metadata, redacted headers, optional request bodies, optional response bodies, and optional WebSocket frame payloads.

GN Tracing uses this data only to create a user-requested debug replay. It does not sell data, use data for advertising, or use data for unrelated analytics.

GN Tracing uploads replay artifacts to the user's Google Drive after the user connects Google Drive. Uploaded replay artifacts are made readable by link so the generated replay URL works. Anyone with the replay URL may be able to view the recording and included artifacts.

## Remote Code Answer

The extension package does not load remote executable JavaScript. Extension pages load packaged scripts from the extension bundle. The hosted replay player at `https://tracing.gnas.dev/` is a separate web app that reads public-by-link Drive artifacts to display the replay.

## Reviewer Test Instructions

1. Install the packaged `dist/` extension.
2. Open a normal test page such as `https://example.com/`.
3. Open the extension popup and connect Google Drive.
4. Confirm the popup shows the capture disclosure and privacy toggles. Request bodies, response bodies, and WebSocket messages are on by default and can be disabled before recording.
5. Start recording, interact with the page, then stop recording.
6. Wait for upload to complete.
7. Open the replay link and confirm the player shows the video and captured artifacts.
8. Confirm the configured Drive upload folder contains the generated GN Tracing zip package and that the link-readable replay loads.

## Pre-submit Checklist

- Root typecheck passes.
- Standalone player typecheck passes.
- Root and standalone dependency audits pass.
- Production extension build succeeds.
- `dist/manifest.json` uses the Store OAuth client id and extension public key for local/unpacked installs.
- `gn-tracing-store.zip` is built with `task store:zip` so `manifest.key` is stripped (Chrome Web Store rejects `key`).
- Manifest permissions match this document.
- OAuth application homepage (branding) is published at `https://tracing.gnas.dev/app/` (static product page; replay player remains at `https://tracing.gnas.dev/`).
- Privacy policy is published at `https://tracing.gnas.dev/privacy/` and linked in the Store dashboard and Google OAuth consent screen.
- Terms of Service is published at `https://tracing.gnas.dev/terms/` for Google OAuth consent screen / Store fields that request it.
- Store privacy fields match the behavior described in `docs/compliance/privacy-policy.md`.
- Screenshots and listing text accurately disclose recording, Drive upload, and link-readable replay behavior.
