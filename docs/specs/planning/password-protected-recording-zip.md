---
title: "Password Protected Recording Zip"
description: "Implemented native ZIP password contract for optional password-protected recording packages."
type: spec
status: implemented
tags: ["replay", "password", "zip-package"]
source_paths:
  - "src/background/service-worker.ts"
  - "src/offscreen/offscreen.ts"
  - "src/popup/popup.ts"
  - "player/player.js"
  - "player/player.html"
  - "player-standalone/index.html"
related:
  - "../../modules/drive-and-player.md"
  - "../../shared/data-models.md"
  - "../../compliance/privacy-policy.md"
---

# Password Protected Recording Zip

## Tổng Quan

Users can configure an optional zip password in the popup settings. When a password is configured, each new recording upload is written as a native password-protected ZIP package before it is uploaded to Google Drive. The Drive file remains link-readable so replay URLs keep working, but ZIP entries require the password before metadata, logs, or video are loaded.

## Package Shape

Unprotected uploads keep the normal package contract:

```text
gn-tracing-*.zip
  recording-index.json
  manifest.json
  metadata.json
  video.part-000.webm
  ...
```

Protected uploads keep the same file shape, but entries are written with traditional ZIP password encryption:

```text
gn-tracing-*.zip
  recording-index.json
  manifest.json
  metadata.json
  video.part-000.webm
  ...
```

The central directory still exposes entry names as normal ZIP metadata. Entry contents are password-protected, so desktop unzip tools and the GN Tracing player both prompt for the password before reading files.

## Password Contract

- ZIP entries use traditional ZIP encryption; JSON/text entries may be DEFLATE-compressed before encryption, while already-compressed video entries stay stored.
- Each protected entry has its own ZIP encryption header.
- CRC-32 remains the integrity check for the final decrypted and, when needed, inflated entry payloads.
- The plaintext password is not written to replay URLs, upload history, package metadata, logs, or popup state snapshots.

The password setting is stored locally by the extension so future uploads can use it. Runtime snapshots expose only `zipPasswordConfigured`.

## Runtime Flow

1. Popup settings send either a new password or a clear-password intent to the service worker.
2. The service worker persists the local setting and returns state snapshots without the plaintext password.
3. During upload, the service worker passes the current password to offscreen only for the upload task.
4. Offscreen builds one recording zip; if a password is present, it compresses eligible JSON/text entries, marks entries as encrypted, and writes encrypted entry payloads.
5. The player detects encrypted ZIP entries, shows the unlock form, decrypts entries in-browser, inflates DEFLATE entries when needed, and then loads the normal artifact parser.

Wrong passwords or corrupt encrypted entries keep the viewer in the unlock state with an actionable error rather than falling through to generic unzip errors.

## Business Rules

- Blank password means new uploads are unprotected.
- Clearing the password affects future uploads only; existing protected packages still need their original password.
- Forgotten passwords cannot be recovered by GN Tracing.
- Password protection protects package contents, not Drive file discoverability.
- Protected and unprotected packages share the same replay URL format.
- The player retains legacy support for older GN Tracing encrypted-payload packages so existing replay links can still be opened.

## Validation

- Manual validation should cover unprotected replay, protected replay with wrong and correct passwords, and clear-password upload.
- Package inspection should confirm protected uploads do not contain `encrypted-payload.bin` and that desktop unzip tools ask for the configured password.
- Player validation should cover both extension-hosted and standalone player shells because both contain the unlock UI.
