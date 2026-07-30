---
title: "GN Tracing Privacy Policy"
description: "Public privacy policy language for GN Tracing capture, multi-cloud upload, and replay behavior."
type: compliance
status: active
tags: ["privacy", "chrome-web-store", "google-drive", "dropbox"]
related:
  - "./chrome-web-store-submission.md"
  - "./terms-of-service.md"
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
- Phạm vi: public privacy policy language for capture, multi-cloud upload (Google Drive, Dropbox), replay, storage, deletion, and sharing behavior
- Nguồn code: `src/background/cdp-manager.ts`, `src/background/service-worker.ts`, `src/offscreen/offscreen.ts`, `src/types/recording.ts`, `src/background/*-auth.ts`
- Tuân thủ: Google API Limited Use (when Google Drive is used), Chrome Web Store data-use disclosure, third-party cloud OAuth disclosures
- Links: [Chrome Web Store Submission](./chrome-web-store-submission.md), [Terms of Service](./terms-of-service.md), [Recording Runtime](../modules/recording-runtime.md), [Cloud Storage And Player](../modules/drive-and-player.md), [Privacy And Redaction](../modules/privacy-and-redaction.md), [Replay Player](../modules/replay-player.md), [Extension Surfaces](../features/extension-surfaces.md), [Shared Data Models](../shared/data-models.md)

## Public URL

- Production: `https://tracing.gnas.dev/privacy/`
- Alternate clean path: `https://tracing.gnas.dev/privacy`
- OAuth application homepage (branding, not the replay player): `https://tracing.gnas.dev/app/`

The canonical HTML page is deployed with the standalone player on Cloudflare Pages
(`player/public/privacy/index.html`). Keep that page aligned with the language below.

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
- local upload history such as replay URL, storage provider, cloud folder identifier when known, page URL, upload time, and duration

GN Tracing does not run continuous background browsing surveillance. It records only after the user starts a recording from the extension popup, and it stops when the user stops recording, removes the recording, or closes the recorded tab.

## How Data Is Used

GN Tracing uses captured data only to create a replayable debugging package. Report metadata, the redacted interaction timeline, the optional screenshot, and the privacy summary help the player render a clearer bug report summary around the video and debugging logs. The extension applies client-side redaction before upload for supported text/JSON evidence, including sensitive headers, URL query parameters, body fields, console values, WebSocket text payloads, report metadata, and event metadata according to the user's privacy settings. The extension stores the captured data temporarily in the extension runtime and browser extension storage so it can show upload progress, retry a pending upload, and generate a replay link.

When a cloud storage provider is connected, GN Tracing uploads the recording package to **the user's own cloud account** for the provider the user selected (Google Drive or Dropbox). If the user configures a zip password, GN Tracing writes a password-protected ZIP package in the browser before upload and the hosted player at `https://tracing.gnas.dev/` asks for that password before loading the replay.

## Cloud Storage, OAuth, And Sharing

GN Tracing does not operate a first-party file storage backend for recordings. Packages are stored in the cloud account the user connects.

### Google Drive

When Google Drive is the active provider, GN Tracing uses the Google Drive `drive.file` scope to create and access files that GN Tracing creates or opens through the user's interaction. It does not request full access to every file in the user's Google Drive.

### Dropbox

When Dropbox is the active provider, GN Tracing uses Dropbox OAuth with scoped access needed to upload recording packages, read package content for replay downloads when authenticated, and create shared links. Requested scopes (scoped Dropbox apps) include `files.content.write`, `files.content.read`, `sharing.write`, `sharing.read`, and `account_info.read`.

### Optional token-exchange proxies

By default, OAuth uses public-client PKCE and exchanges tokens directly with the cloud provider from the extension. When a deployment configures an optional token-exchange proxy URL (`GOOGLE_TOKEN_PROXY_URL` or `DROPBOX_TOKEN_PROXY_URL`), the extension POSTs OAuth grant or refresh requests (authorization code, PKCE code verifier, or refresh token as required by the grant) to that maintainer-operated endpoint so a server-side client secret can be injected before the request reaches Google or Dropbox. Proxies are intended only to complete the provider token exchange; they must not persist codes, verifiers, or tokens, and they are not used for product analytics. When those proxy URLs are unset, OAuth grant material is not sent to a GN Tracing-operated Worker.

### Public link-readable model

Uploaded replay artifacts are made readable by link so the replay URL can be opened by teammates or other people the user shares it with. Anyone with an unprotected replay URL may be able to view the recording video, optional screenshot, report metadata, redacted interaction timeline, privacy summary, and included debugging artifacts. Password-protected replay packages still use a link-readable cloud file, but the recording contents require the password in the GN Tracing player or a compatible unzip tool. Users should avoid recording pages that contain confidential information unless they intend to share that information through the generated replay link and, when configured, its password.

Replay URLs are namespaced by provider, for example:

- `https://tracing.gnas.dev/gdrive/<id>`
- `https://tracing.gnas.dev/dropbox/<id>`

Legacy Google Drive bare-id links (`https://tracing.gnas.dev/<file-id>`) may still open older uploads.

## Data Storage And Deletion

Before upload, recording data is held in the extension runtime and browser extension storage. Optional zip password settings are stored locally by the extension and are not placed in replay URLs, upload history, uploaded package metadata, or the page-injected event collector. After upload, recording artifacts are stored in the user's selected cloud (Google Drive or Dropbox). Upload history is stored locally by the extension and is not synced into the cloud storage account.

OAuth access and refresh tokens are stored locally in the browser extension storage for the provider that was connected. Tokens are used only to authenticate to that provider's APIs for upload, share, disconnect/revoke, and authenticated extension-player download. Tokens are not embedded in replay URLs or package metadata. Except for the optional token-exchange proxy path described above (when configured), access and refresh tokens are not uploaded to GN Tracing infrastructure, and proxies must not keep them after exchange.

Users can delete local upload history from the extension UI. Users can delete uploaded recordings by deleting the generated GN Tracing zip package from their cloud storage account. Users can disconnect a provider in the extension to clear local tokens for that provider (cloud files are not deleted automatically).

## Data Sharing

GN Tracing does not sell captured data. GN Tracing does not use captured data for advertising, creditworthiness, or unrelated analytics. Captured data is shared only as needed to provide the user-requested replay flow:

- uploaded recording artifacts are stored in the user's selected cloud storage account
- replay artifacts are made readable by link so the replay URL works
- the hosted player fetches those link-readable artifacts (via same-origin download proxies when needed) to display the replay

## No Product Telemetry

GN Tracing does not include third-party product analytics or advertising SDKs that report browsing activity. Developer-facing console warnings may log high-level auth or upload failure messages for debugging in the browser console; they must not log OAuth token values, refresh tokens, or raw recording package contents. There is no remote telemetry pipeline that exports tokens or file bodies.

## Optional Product Feedback

When you use the in-extension **Feedback** control and press Submit, GN Tracing sends only the text you typed plus light environment diagnostics (extension version, browser name/version, operating system label, and locale) to a maintainer-operated Cloudflare Worker. That Worker creates a **public** GitHub issue on the GN Tracing repository so the maintainer can review the report. Feedback is opt-in and never submitted automatically. Do not include passwords, OAuth tokens, or confidential recording contents in feedback text. Feedback is not part of the recording/upload pipeline and is separate from cloud storage packages.

## Google API Limited Use

When Google Drive is used, GN Tracing's use and transfer of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements. Google Drive data is used only to create, read, share, and manage GN Tracing recording artifacts needed for the replay feature.

## Contact

For questions, support, or deletion help, open an issue at `https://github.com/gnasdev/gn-tracing/issues` or contact `ngosangns@gmail.com`.
