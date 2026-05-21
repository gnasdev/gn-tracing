---
title: "Drive API Alt Media Player Download"
description: "Implemented replay download strategy for authenticated Drive API media fetches and public proxy fallback."
type: spec
status: implemented
tags: ["replay", "google-drive", "download"]
source_paths:
  - "player/player.js"
  - "src/background/service-worker.ts"
  - "src/types/messages.ts"
  - "player-standalone/functions/api/drive.js"
  - "player-standalone/vite.config.ts"
related:
  - "../../modules/drive-and-player.md"
  - "../../shared/api-conventions.md"
  - "../../shared/data-models.md"
---

# Drive API Alt Media Player Download

## Tổng Quan

Replay downloads use the Google Drive API media endpoint when the player has an extension OAuth token, and fall back to the public standalone proxy when no token is available or an auth/access failure can still succeed through a link-readable file.

The parser and replay artifact model do not know about OAuth. Download strategy returns blobs or JSON responses; package parsing stays independent.

## Authenticated Download

The extension-hosted player can request a short-lived in-memory token from the service worker with `GET_GOOGLE_DRIVE_TOKEN`. When available, package and artifact downloads use:

```text
https://www.googleapis.com/drive/v3/files/<fileId>?alt=media&supportsAllDrives=true
Authorization: Bearer <access-token>
```

The token is not placed in replay URLs, uploaded artifacts, Cache API keys, logs, local storage, or Cloudflare proxy requests.

## Public Proxy Fallback

Hosted standalone replay uses the same-origin Cloudflare Pages Function:

```text
/api/drive?id=<file-id>
```

The proxy streams public Google Drive downloads to avoid browser CORS/CORP failures. It resolves large-file confirmation pages, including form-based confirmation flows, before returning artifact bytes. If Drive still returns HTML instead of the expected package bytes, the proxy returns a non-cacheable error so the player can avoid caching a confirmation page as a replay artifact.

The local standalone Vite dev server mirrors this proxy behavior for replay testing.

## Error Handling

- `401` from Drive API means the token is invalid or expired.
- `403` means the current token cannot read the file; public fallback may still work for link-readable packages.
- `404` means the file is missing or invisible to the current identity and should not be retried indefinitely.
- `text/html` responses are treated as wrong-contract Drive pages, not recording indexes or zip packages.
- Stale cached HTML is removed before retrying package downloads.

## Scope Rules

GN Tracing keeps the Drive scope at `https://www.googleapis.com/auth/drive.file`. This supports app-created recording artifacts without requesting full Drive access. Hosted web OAuth is out of scope for the current player; standalone replay remains public-by-link through the proxy unless a future product decision adds web login.

## Validation

- Extension replay should prefer Drive API media downloads when Drive is connected.
- Hosted standalone replay should work without an OAuth token through `/api/drive`.
- Large public Drive files should not poison replay cache with confirmation HTML.
- Password-protected packages use the same outer-package download path and then unlock locally in the browser.
