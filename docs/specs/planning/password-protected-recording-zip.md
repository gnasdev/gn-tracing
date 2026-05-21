---
title: "Password Protected Recording Zip"
description: "Implemented client-side encryption contract for optional password-protected recording packages."
type: spec
status: implemented
tags: ["replay", "encryption", "zip-package"]
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

Users can configure an optional zip password in the popup settings. When a password is configured, each new recording upload is encrypted in the browser before it is written to Google Drive. The Drive file remains link-readable so replay URLs keep working, but the recording contents require the password in the GN Tracing player before metadata, logs, or video are loaded.

This is a GN Tracing encrypted package, not a native ZIP password format for desktop unzip tools.

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

Protected uploads wrap that normal package in an encrypted outer package:

```text
gn-tracing-*.zip
  recording-index.json
  encrypted-payload.bin
```

The clear outer `recording-index.json` contains only encryption metadata and the encrypted payload path. The decrypted payload is the normal inner recording zip.

## Cryptography Contract

- Key derivation: `PBKDF2-SHA-256`.
- Encryption: `AES-GCM`.
- Each upload uses a random salt and IV.
- The encryption metadata stores algorithm, KDF, iteration count, salt, IV, payload path, and cleartext type.
- The plaintext password is not written to replay URLs, upload history, package metadata, logs, or popup state snapshots.

The password setting is stored locally by the extension so future uploads can use it. Runtime snapshots expose only `zipPasswordConfigured`.

## Runtime Flow

1. Popup settings send either a new password or a clear-password intent to the service worker.
2. The service worker persists the local setting and returns state snapshots without the plaintext password.
3. During upload, the service worker passes the current password to offscreen only for the upload task.
4. Offscreen builds the normal inner recording zip.
5. If a password is present, offscreen encrypts the inner zip and uploads the outer encrypted package.
6. The player detects encryption metadata, shows the unlock form, decrypts `encrypted-payload.bin`, and then loads the inner zip through the normal parser.

Wrong passwords or corrupt encrypted payloads keep the viewer in the unlock state with an actionable error rather than falling through to generic unzip errors.

## Business Rules

- Blank password means new uploads are unprotected.
- Clearing the password affects future uploads only; existing protected packages still need their original password.
- Forgotten passwords cannot be recovered by GN Tracing.
- Password protection protects package contents, not Drive file discoverability.
- Protected and unprotected packages share the same replay URL format.

## Validation

- Manual validation should cover unprotected replay, protected replay with wrong and correct passwords, and clear-password upload.
- Package inspection should confirm protected uploads reveal only encryption metadata plus `encrypted-payload.bin`.
- Player validation should cover both extension-hosted and standalone player shells because both contain the unlock UI.
