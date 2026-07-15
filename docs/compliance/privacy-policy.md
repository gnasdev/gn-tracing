---
title: "GN Tracing Privacy Policy"
description: "Public privacy policy language for GN Tracing capture, upload, and replay behavior."
type: compliance
status: active
tags: ["privacy", "chrome-web-store", "google-drive"]
related:
  - "./chrome-web-store-submission.md"
  - "../modules/recording-runtime.md"
  - "../modules/drive-and-player.md"
  - "../modules/privacy-and-redaction.md"
  - "../modules/replay-player.md"
  - "../features/extension-surfaces.md"
  - "../shared/data-models.md"
---

# GN Tracing Privacy Policy

## Meta

- Trạng thái: active
- Phạm vi: public privacy policy language for capture, upload, replay, Google Drive access, storage, deletion, and sharing behavior
- Nguồn code: `src/background/cdp-manager.ts`, `src/background/service-worker.ts`, `src/offscreen/offscreen.ts`, `src/types/recording.ts`
- Tuân thủ: Google API Limited Use, Chrome Web Store data-use disclosure
- Links: [Chrome Web Store Submission](./chrome-web-store-submission.md), [Recording Runtime](../modules/recording-runtime.md), [Drive And Player](../modules/drive-and-player.md), [Privacy And Redaction](../modules/privacy-and-redaction.md), [Replay Player](../modules/replay-player.md), [Extension Surfaces](../features/extension-surfaces.md), [Shared Data Models](../shared/data-models.md)

GN Tracing is a browser debugging extension that records a tab when the user explicitly starts a recording. It is designed to help users create a replayable bug report that includes the screen recording and selected debugging artifacts from that tab.

## Data GN Tracing Collects

GN Tracing may collect the following data for the tab being recorded:

- tab video and tab audio when available
- page URL, page title, recording timestamps, duration, and basic browser/page environment context such as extension version, browser label, viewport, screen size, language, and timezone
- a redacted interaction timeline with navigation, click, focus, submit, and named keyboard key/shortcut summaries; GN Tracing records keys such as Enter, Escape, and Ctrl/Meta chords for debugging, but does not store raw typed form or password input in this timeline
- an optional visible-tab screenshot captured when the user stops recording
- console logs, runtime errors, stack traces, and source-map-enhanced locations
- network request metadata such as URL, method, status, timing, resource type, protocol, remote IP address, and encoded size
- request and response headers with sensitive header values redacted by default
- request bodies, response bodies, and WebSocket message payloads when those capture options are enabled
- redaction summary metadata such as policy version, selected privacy profile, artifact flags, grouped redaction counts, and known limitations; this summary does not include raw secret values
- optional DOM selector rules used locally by the extension to visually mask matching page elements during recording
- optional zip password settings for protecting new uploads
- local upload history such as replay URL, Drive folder ID, page URL, upload time, and duration

GN Tracing does not run continuous background browsing surveillance. It records only after the user starts a recording from the extension popup, and it stops when the user stops recording, removes the recording, or closes the recorded tab.

## How Data Is Used

GN Tracing uses captured data only to create a replayable debugging package. Report metadata, the redacted interaction timeline, the optional screenshot, and the privacy summary help the player render a clearer bug report summary around the video and debugging logs. The extension applies client-side redaction before upload for supported text/JSON evidence, including sensitive headers, URL query parameters, body fields, console values, WebSocket text payloads, report metadata, and event metadata according to the user's privacy settings. The extension stores the captured data temporarily in the extension runtime and browser extension storage so it can show upload progress, retry a pending upload, and generate a replay link.

When Google Drive is connected, GN Tracing uploads the recording artifacts to the user's Google Drive. If the user configures a zip password, GN Tracing writes a password-protected ZIP package in the browser before upload and the hosted player at `https://tracing.gnas.dev/` asks for that password before loading the replay.

## Google Drive And Sharing

GN Tracing uses the Google Drive `drive.file` scope to create and access files that GN Tracing creates or opens through the user's interaction. It does not request full access to every file in the user's Google Drive.

Uploaded replay artifacts are made readable by link so the replay URL can be opened by teammates or other people the user shares it with. Anyone with an unprotected replay URL may be able to view the recording video, optional screenshot, report metadata, redacted interaction timeline, privacy summary, and included debugging artifacts. Password-protected replay packages still use a link-readable Drive file, but the recording contents require the password in the GN Tracing player or a compatible unzip tool. Users should avoid recording pages that contain confidential information unless they intend to share that information through the generated replay link and, when configured, its password.

## Data Storage And Deletion

Before upload, recording data is held in the extension runtime and browser extension storage. Optional zip password settings are stored locally by the extension and are not placed in replay URLs, upload history, uploaded package metadata, or the page-injected event collector. After upload, recording artifacts, including any report, event, privacy summary, and screenshot artifacts captured for that session, are stored in the user's Google Drive. Upload history is stored locally by the extension and is not synced into Google Drive.

Users can delete local upload history from the extension UI. Users can delete uploaded recordings by deleting the generated GN Tracing zip package from Google Drive.

## Data Sharing

GN Tracing does not sell captured data. GN Tracing does not use captured data for advertising, creditworthiness, or unrelated analytics. Captured data is shared only as needed to provide the user-requested replay flow:

- uploaded recording artifacts are stored in the user's Google Drive
- replay artifacts are made readable by link so the replay URL works
- the hosted player fetches those link-readable artifacts to display the replay

## Google API Limited Use

GN Tracing's use and transfer of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements. Google Drive data is used only to create, read, share, and manage GN Tracing recording artifacts needed for the replay feature.

## Contact

For questions, support, or deletion help, open an issue at `https://github.com/gnasdev/gn-tracing/issues`.
