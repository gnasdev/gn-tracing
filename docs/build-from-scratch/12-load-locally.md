---
title: "12 - Load Locally"
description: "Side-load the built dist/ into a Chromium browser and smoke-test the popup, recording, and player."
type: build
status: active
tags: ["build", "load", "chrome", "smoke-test"]
related:
  - "./03-extension-root-manifest.md"
  - "./04-extension-build-esbuild.md"
  - "./13-release-flow.md"
---

# 12 - Load Locally

## Meta

- Goal: get the freshly built extension running in Chrome/Edge so you can poke every UI surface by hand.
- Verification: clicking the toolbar action opens the popup; starting a recording attaches CDP to a tab and produces `chrome.storage.session` updates you can inspect.

## 12.1 Build Once

```bash
# from repo root
node esbuild.config.mjs --env development
# or
task build
```

Confirm:

```bash
ls dist/manifest.json dist/background/service-worker.js dist/popup/popup.js
```

## 12.2 Open Chrome

1. Navigate to `chrome://extensions` (or `edge://extensions`).
2. Toggle **Developer mode** in the top-right.
3. Click **Load unpacked**.
4. Pick the `dist/` folder at the repo root.

Chrome prints the extension ID below the card. Verify it equals the SHA-256-derived ID from chapter `01`. If it doesn't match:

- Stop here. The mismatch means the public key in `.env` is wrong, or the build script tampered with `manifest.json#key`.
- Re-check `CHROME_EXTENSION_PUBLIC_KEY` and rerun `task build`.

## 12.3 Smoke Test the Popup

1. Click the toolbar icon. The popup should open and show **Cloud storage** status with a **Connect** button (active provider is set in Settings).
2. Click that button. A new tab opens at the standalone `drive-auth` page.
3. Walk through the Google consent flow. On success the popup should reflect the connected state.
4. Open any non-recordable page (`chrome://extensions`, `chrome://flags`, `chromewebstore.google.com`).
   - The popup should grey out the **Start Recording** button and show the block reason.
5. Open `https://example.com`.
   - The button enables.
6. Click **Start Recording**.
7. Within a second the recording badge should appear on the toolbar icon; the popup status flips to "Recording".

## 12.4 Verify the Offscreen Document

Open `chrome://extensions` → your extension → **Service worker** dropdown → **Offscreen**. You should see a card labeled with `offscreen.html`. If it is missing:

- Manifest permission `offscreen` was dropped (chapter `03`).
- The recorder manager threw before spinning up the document; check the service-worker console (`chrome://extensions` → "Service worker" → "Inspect").

## 12.5 Verify `chrome.storage.session`

In the same Service Worker devtools window, run:

```js
chrome.storage.session.get(null).then(console.log);
```

You should see a status object with at least `recordingState` and `lastUpdated`.

## 12.6 Stop Recording and Inspect Artifacts

1. Click **Stop Recording** in the popup.
2. Wait for the offscreen document to finalize.
3. Inspect the same `chrome.storage.session` payload — the status should transition through `finalizing` to `ready-to-upload`.
4. With a valid Drive token, the upload should start automatically. Without one, the popup should expose a manual upload button.

If the upload fails, the most common causes are:

- `host_permissions` missing the OAuth proxy URL (chapter `08`).
- `chrome.identity` blocked by the browser (open the `drive-auth` page directly to retry).
- Token expired — reconnect.

## 12.7 Open the Built-in Replay Page

The extension ships the replay UI at `chrome-extension://<extension-id>/player/player.html`. Open it directly:

```text
chrome-extension://<extension-id>/player/player.html
```

It loads the same `player/player.html` from `dist/` that hosted replays use. This is the in-extension fallback when the standalone player cannot reach the package.

## 12.8 Iterating

After every source change, click the **Reload** button on `chrome://extensions`. For static asset or manifest changes that you want hot-reload for, run `task watch` instead of `task build`.

## 12.9 When You Need a Clean Slate

If the popup gets stuck:

```text
chrome://extensions → Remove → Load unpacked again
```

The MV3 service worker keeps session state in memory and `chrome.storage.session` dies with the worker; nothing in `chrome.storage.local` is rewritten during a normal stop.

## You Should Now Have

- An extension you can drive by clicking the toolbar icon.
- A recording that starts, stops, and either uploads or stays pending.
- A replay view at the `chrome-extension://.../player/player.html` URL.

Move on to [13 - Release Flow](./13-release-flow.md).
