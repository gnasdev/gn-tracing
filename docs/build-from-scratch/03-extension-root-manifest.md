---
title: "03 - Extension Manifest Template"
description: "manifest.template.json placeholders, permissions, OAuth2 client, and how the build fills them in."
type: build
status: active
tags: ["build", "manifest", "mv3"]
related:
  - "./01-prerequisites.md"
  - "./02-scaffolding.md"
  - "./04-extension-build-esbuild.md"
---

# 03 - Extension Manifest Template

## Meta

- Goal: ship a valid `manifest.template.json` that `esbuild.config.mjs` can stamp into `dist/manifest.json`.
- Verification: `node esbuild.config.mjs --env production` produces `dist/manifest.json` with no placeholders left and a version that matches `package.json`.

## 3.1 Why a Template

`esbuild.config.mjs` reads `manifest.template.json` and substitutes two placeholders:

- `{{GOOGLE_CLIENT_ID}}` — the OAuth client ID from chapter `01`.
- `{{CHROME_EXTENSION_PUBLIC_KEY}}` — the base64-DER public key from chapter `01`.

The function `generateManifest()` in `esbuild.config.mjs` replaces these, syncs the `version` field from `package.json`, and optionally appends the OAuth-proxy origin to `host_permissions` (covered in chapter `08`). The hardcoded `manifest.json` at the repo root is the same template shape but without placeholders; the build always emits the file under `dist/manifest.json`.

## 3.2 The Template

Create `manifest.template.json`:

```json
{
  "manifest_version": 3,
  "name": "gn-tracing",
  "version": "1.0.12",
  "minimum_chrome_version": "120",
  "description": "Record tab video, console logs, and network requests for debugging",
  "permissions": [
    "tabCapture",
    "offscreen",
    "debugger",
    "scripting",
    "activeTab",
    "storage",
    "alarms",
    "identity"
  ],
  "host_permissions": [
    "https://api.github.com/",
    "https://oauth2.googleapis.com/",
    "https://www.googleapis.com/"
  ],
  "oauth2": {
    "client_id": "{{GOOGLE_CLIENT_ID}}",
    "scopes": ["https://www.googleapis.com/auth/drive.file"]
  },
  "key": "{{CHROME_EXTENSION_PUBLIC_KEY}}",
  "background": {
    "service_worker": "background/service-worker.js",
    "type": "module"
  },
  "action": {
    "default_popup": "popup/popup.html",
    "default_icon": {
      "16": "icons/icon16.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    }
  },
  "icons": {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  }
}
```

## 3.3 Field-by-Field Explanation

- `manifest_version: 3` and `minimum_chrome_version: "120"` — required for the offscreen-document capture, `chrome.debugger`, `chrome.tabCapture` APIs and the modern `chrome.alarms` keepalive.
- `permissions`:
  - `tabCapture`, `offscreen` — required to use `chrome.tabCapture` and to host a `MediaRecorder` outside the service worker.
  - `debugger` — required for full CDP capture (network, console, WebSocket, source maps).
  - `scripting` — required to inject content scripts programmatically when the user starts a recording.
  - `activeTab` — gates UI features on the current tab without pre-declared host permissions.
  - `storage` — required for both `chrome.storage.session` (live status) and `chrome.storage.local` (settings).
  - `alarms` — used as a service-worker keepalive while recording.
  - `identity` — required for the Chromium-wide Google OAuth flow.
- `host_permissions`:
  - `api.github.com/` — version check + download-discovery against public GitHub Releases.
  - `oauth2.googleapis.com/` and `googleapis.com/` — direct-to-Google token exchange and Drive API calls.
  - When chapter `08` adds `GOOGLE_TOKEN_PROXY_URL`, the Worker origin is appended.
- `oauth2.client_id` — the Web-application OAuth client from chapter `01`. The `drive.file` scope limits the extension to files it creates itself, which is the disclosed behavior in the Store listing.
- `key` — the base64-DER public key. Chrome derives the extension ID from this and refuses to install two packages with mismatched IDs.
- `background.service_worker` — points at the ESM bundle that chapter `04` emits.
- `action.default_popup` — points at the static HTML that chapter `05` copies.

## 3.4 Version Sync

The `version` field in the template is overwritten by `package.json` at build time. Do not edit it by hand; bump it in `package.json` and the next build picks it up. Chapter `13` documents the tag-driven release flow that drives this.

## 3.5 What the Build Validates

`validateChromeExtensionIdentity()` runs before `dist/manifest.json` is written. It refuses to build a production package when:

- `GOOGLE_CLIENT_ID` is missing.
- `CHROME_EXTENSION_ID` is missing in production builds.
- `CHROME_EXTENSION_PUBLIC_KEY` is missing.
- `CHROME_EXTENSION_ID` does not match the SHA-256-derived ID from the public key.

A development build (`--env development`) skips the `CHROME_EXTENSION_ID` check so you can iterate without filling in that field.

## 3.6 Sanity Check

After chapter `04` wires the build, you can emit the manifest in isolation by running a development build:

```bash
node esbuild.config.mjs --env development
cat dist/manifest.json | jq .oauth2.client_id   # should be empty or your dev client id
cat dist/manifest.json | jq .version           # should match package.json
```

Confirm the output JSON contains no `{{...}}` placeholders and no `null` for `oauth2.client_id` once `.env` is populated (chapter `10`).

## You Should Now Have

- `manifest.template.json` at the repo root.
- A rough mental model of the permissions and host permissions.
- Confirmation (after chapter `04`) that `dist/manifest.json` is generated.

Move on to [04 - Extension Build](./04-extension-build-esbuild.md).
