---
title: "Chrome Web Store Submission Notes"
description: "Store listing, permission, data usage, remote code, and reviewer instruction notes for GN Tracing."
type: compliance
status: active
tags: ["chrome-web-store", "permissions", "privacy", "multi-cloud"]
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
- Links: [Privacy Policy](./privacy-policy.md), [Recording Runtime](../modules/recording-runtime.md), [Cloud Storage And Player](../modules/drive-and-player.md), [Privacy And Redaction](../modules/privacy-and-redaction.md), [Replay Player](../modules/replay-player.md), [Extension Surfaces](../features/extension-surfaces.md), [API Conventions](../shared/api-conventions.md)

This document is the working checklist for submitting GN Tracing to the Chrome Web Store.

## Single Purpose

GN Tracing records a user-selected browser tab and packages the video, console logs, network activity, and optional WebSocket/body payload details into a shareable debugging replay. After the user connects a cloud storage account (Google Drive or Dropbox), the extension uploads that package to the user's own cloud and returns a replay link for the hosted player.

## Permission Justifications

`tabCapture` is required to record video and audio from the active tab selected by the user.

`offscreen` is required because Manifest V3 service workers cannot own long-running `MediaRecorder` capture and upload work directly.

`debugger` is required to attach Chrome Debugger Protocol to the selected tab during an active recording. GN Tracing uses CDP to collect console logs, runtime exceptions, network metadata, request/response headers, optional request/response bodies, and WebSocket activity. The extension attaches only after the user starts recording and detaches when recording stops or the tab closes.

`activeTab` is required so the popup can identify the active tab the user chose to record.

`storage` is required to store popup state, upload settings, pending session summaries, local upload history, and temporary recording artifacts before upload.

`alarms` is required to keep the Manifest V3 service worker awake while a recording is active.

`identity` is required for OAuth sign-in and token management for the connected cloud storage providers (Google Drive and/or Dropbox depending on build configuration and user choice).

GN Tracing does not request broad `<all_urls>` host access. Recording uses the user-selected active tab plus `debugger` and `tabCapture`. Fixed `host_permissions` come from `manifest.template.json` (and optional Worker origins injected at build time). As of the multi-cloud manifest template:

- Google: `https://oauth2.googleapis.com/`, `https://www.googleapis.com/`
- Dropbox: `https://api.dropboxapi.com/`, `https://content.dropboxapi.com/`, `https://www.dropbox.com/`, `https://dl.dropboxusercontent.com/`
- optional token proxy Worker origins when `GOOGLE_TOKEN_PROXY_URL` or `DROPBOX_TOKEN_PROXY_URL` is set (origin of each configured URL is appended to `host_permissions` at build)

Confirm the packaged Store build against generated `dist/manifest.json` `host_permissions` and `scripts/check-store-package.mjs`. Do not expand to broad wildcards (including broad `*.sharepoint.com`) for Store builds.

## Data Usage Answers

GN Tracing collects web browsing activity for the tab the user records. This includes URL, video/audio, console logs, runtime errors, network request metadata, redacted headers, optional request bodies, optional response bodies, and optional WebSocket frame payloads.

GN Tracing uses this data only to create a user-requested debug replay. It does not sell data, use data for advertising, or use data for unrelated analytics. It does not run continuous background surveillance.

GN Tracing uploads replay packages to the user's selected cloud storage (Google Drive or Dropbox) after the user connects that provider. Uploaded packages are made readable by link so the generated replay URL works. Anyone with an unprotected replay URL may be able to view the recording and included artifacts. Optional zip passwords protect package contents inside a still link-readable cloud file.

OAuth tokens are stored locally in the extension and used only for provider APIs. Tokens and package contents are not sent to third-party analytics.

### Limited use / data handling per cloud OAuth

| Provider | Data accessed | Purpose | Storage location |
|----------|---------------|---------|------------------|
| Google Drive | Files GN Tracing creates/opens (`drive.file`) | Create package, set link-readable permission, authenticated extension replay download | User's Google Drive |
| Dropbox | Files and shared links within granted scopes | Upload package, create shared link, authenticated download when available | User's Dropbox |

GN Tracing does not use cloud API data for advertising, credit scoring, or selling to data brokers. Google API use adheres to Google API Services User Data Policy Limited Use requirements when Drive is used.

## Remote Code Answer

The extension package does not load remote executable JavaScript. Extension pages load packaged scripts from the extension bundle. The hosted replay player at `https://tracing.gnas.dev/` is a separate web app that reads public-by-link cloud artifacts (via same-origin proxies when needed) to display the replay.

## Reviewer Test Instructions

1. Install the packaged `dist/` extension (or Store package with `key` stripped).
2. Open a normal test page such as `https://example.com/`.
3. Open Settings and confirm **Storage provider** offers Google Drive and Dropbox (as built).
4. Open the extension popup and connect the active cloud storage provider.
5. Confirm the popup shows the capture disclosure and that capture detail/password options live in Settings.
6. Start recording, interact with the page, then stop recording.
7. Wait for upload to complete.
8. Open the replay link and confirm the player shows the video and captured artifacts. Namespaced paths look like `/gdrive/...`, `/dropbox/....
9. Confirm the configured cloud folder contains the generated GN Tracing zip package and that the link-readable replay loads in a window without the extension (standalone player).

Optional matrix: repeat connect → upload → anonymous replay for Dropbox when that client id is configured in the build under review.

## Pre-submit Checklist

- Root typecheck passes.
- Standalone player typecheck passes.
- Root and standalone dependency audits pass.
- Production extension build succeeds.
- `dist/manifest.json` uses the Store OAuth client id and extension public key for local/unpacked installs.
- `gn-tracing-store.zip` is built with `task store:zip` so `manifest.key` is stripped (Chrome Web Store rejects `key`).
- Manifest permissions match this document and the Store privacy questionnaire.
- OAuth application homepage (branding) is published at `https://tracing.gnas.dev/app/` (static product page; replay player remains at `https://tracing.gnas.dev/`).
- Privacy policy is published at `https://tracing.gnas.dev/privacy/` and linked in the Store dashboard and relevant OAuth consent screens.
- Terms of Service is published at `https://tracing.gnas.dev/terms/` for consent screen / Store fields that request it.
- Store privacy fields match the behavior described in `docs/compliance/privacy-policy.md`, including multi-cloud upload and link-readable sharing.
- Screenshots and listing text accurately disclose recording, cloud storage upload (not Google-only if multi-provider is shipped), and link-readable replay behavior.
