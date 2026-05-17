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
  - "../shared/data-models.md"
---

# GN Tracing Privacy Policy

## Meta

- Trạng thái: active
- Phạm vi: public privacy policy language for capture, upload, replay, Google Drive access, storage, deletion, and sharing behavior
- Nguồn code: `src/background/cdp-manager.ts`, `src/background/service-worker.ts`, `src/offscreen/offscreen.ts`, `src/types/recording.ts`
- Tuân thủ: Google API Limited Use, Chrome Web Store data-use disclosure
- Links: [Chrome Web Store Submission](./chrome-web-store-submission.md), [Recording Runtime](../modules/recording-runtime.md), [Drive And Player](../modules/drive-and-player.md), [Shared Data Models](../shared/data-models.md)

GN Tracing is a browser debugging extension that records a tab when the user explicitly starts a recording. It is designed to help users create a replayable bug report that includes the screen recording and selected debugging artifacts from that tab.

## Data GN Tracing Collects

GN Tracing may collect the following data for the tab being recorded:

- tab video and tab audio when available
- page URL and recording timestamps
- console logs, runtime errors, stack traces, and source-map-enhanced locations
- network request metadata such as URL, method, status, timing, resource type, protocol, remote IP address, and encoded size
- request and response headers with sensitive header values redacted by default
- request bodies, response bodies, and WebSocket message payloads only when the user enables those capture options
- local upload history such as replay URL, Drive folder ID, page URL, upload time, and duration

GN Tracing does not run continuous background browsing surveillance. It records only after the user starts a recording from the extension popup, and it stops when the user stops recording, removes the recording, or closes the recorded tab.

## How Data Is Used

GN Tracing uses captured data only to create a replayable debugging package. The extension stores the captured data temporarily in the extension runtime and browser extension storage so it can show upload progress, retry a pending upload, and generate a replay link.

When Google Drive is connected, GN Tracing uploads the recording artifacts to the user's Google Drive. The hosted player at `https://tracing.gnas.dev/` loads the uploaded artifacts from Google Drive when someone opens the replay link.

## Google Drive And Sharing

GN Tracing uses the Google Drive `drive.file` scope to create and access files that GN Tracing creates or opens through the user's interaction. It does not request full access to every file in the user's Google Drive.

Uploaded replay artifacts are made readable by link so the replay URL can be opened by teammates or other people the user shares it with. Anyone with the replay URL may be able to view the recording video and included debugging artifacts. Users should avoid recording pages that contain confidential information unless they intend to share that information through the generated replay link.

## Data Storage And Deletion

Before upload, recording data is held in the extension runtime and browser extension storage. After upload, recording artifacts are stored in the user's Google Drive. Upload history is stored locally by the extension and may also be synced into the configured Google Drive upload folder as `gn-tracing-upload-history.json`.

Users can delete local upload history from the extension UI. Users can delete uploaded recordings by deleting the generated GN Tracing folder or files from Google Drive.

## Data Sharing

GN Tracing does not sell captured data. GN Tracing does not use captured data for advertising, creditworthiness, or unrelated analytics. Captured data is shared only as needed to provide the user-requested replay flow:

- uploaded recording artifacts are stored in the user's Google Drive
- replay artifacts are made readable by link so the replay URL works
- the hosted player fetches those link-readable artifacts to display the replay

## Google API Limited Use

GN Tracing's use and transfer of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements. Google Drive data is used only to create, read, share, and manage GN Tracing recording artifacts needed for the replay feature.

## Contact

For questions, support, or deletion help, open an issue at `https://github.com/gnasdev/gn-tracing/issues`.
