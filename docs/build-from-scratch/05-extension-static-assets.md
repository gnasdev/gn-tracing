---
title: "05 - Static Extension Assets"
description: "HTML, CSS, icons, theme, and vendored player files copied verbatim into dist/."
type: build
status: active
tags: ["build", "assets", "html", "css"]
related:
  - "./04-extension-build-esbuild.md"
  - "./06-extension-source-layers.md"
  - "./07-standalone-player.md"
---

# 05 - Static Extension Assets

## Meta

- Goal: make every HTML, CSS, icon, theme, and vendored player file arrive at the right path under `dist/`.
- Verification: `ls dist/` should show the same structure as the entries below, and after `task build` the folder loads in Chrome (chapter `12`).

## 5.1 The `STATIC_ASSET_ENTRIES` Table

The full list lives in `esbuild.config.mjs`. Reproduced here in build-from-scratch order:

| Source path | Destination under `dist/` | Type |
| --- | --- | --- |
| `popup/popup.html` | `dist/popup/popup.html` | text |
| `popup/popup.css` | `dist/popup/popup.css` | file |
| `history/history.html` | `dist/history/history.html` | text |
| `history/history.css` | `dist/history/history.css` | file |
| `settings/settings.html` | `dist/settings/settings.html` | text |
| `settings/settings.css` | `dist/settings/settings.css` | file |
| `offscreen/offscreen.html` | `dist/offscreen/offscreen.html` | text |
| `drive-auth/drive-auth.html` | `dist/drive-auth/drive-auth.html` | text |
| `icons/` | `dist/icons/` | dir |
| `shared/theme.css` | `dist/shared/theme.css` | file |
| `shared/theme-init.js` | `dist/shared/theme-init.js` | file |
| `player/player.html` | `dist/player/player.html` | file |
| `player/player.css` | `dist/player/player.css` | file |
| `player/player.js` | `dist/player/player.js` | file |
| `player/icons/` | `dist/player/icons/` | dir |
| `player/vendor/` | `dist/player/vendor/` | dir |

## 5.2 Surface-by-Surface Notes

### `popup/popup.html` and `popup/popup.css`

The popup is the toolbar action. It boots from `src/popup/popup.ts` (chapter `06`), reads state from `chrome.storage.session`, and dispatches `START_RECORDING` / `STOP_RECORDING` messages.

The HTML must include `<script src="popup.js"></script>` (esbuild emits the file as a sibling).

### `settings/settings.html` and `settings/settings.css`

The Settings page is opened from the popup and lives in its own extension page. It reads and writes capture/privacy settings (redaction toggles, DOM masking, capture mode, advanced capture). Cloud provider and upload folder are edited on the popup storage card.

### `history/history.html` and `history/history.css`

A small page listing locally cached upload history. No Drive read; the history is a Chrome-local cache.

### `offscreen/offscreen.html`

A near-empty HTML file (`<!doctype html><body></body>` plus the script tag). MV3 service workers cannot hold `MediaRecorder` or `fetch` Drive uploads, so this offscreen document becomes the actual recorder + uploader.

### `drive-auth/drive-auth.html`

The Google OAuth page opened in a normal browser tab. It survives popup teardown so the redirect handler is not killed mid-flow.

### `icons/`

Pinned icon PNGs at 16, 48, and 128 pixels plus a source `icons/icon.svg`. They are referenced from `manifest.json` (chapter `03`).

### `shared/theme.css` + `shared/theme-init.js`

A shared design-system stylesheet plus a tiny script that applies the saved theme before paint to avoid a flash. Both the extension UIs and the standalone player load them.

### `player/player.html` + `player/player.css` + `player/player.js`

Prebuilt replay player assets. They are static and copied verbatim into `dist/player/` so the extension can host the replay view directly without depending on a remote URL.

### `player/icons/` + `player/vendor/`

Phosphor icon font CSS and vendored `luna-object-viewer`/`luna-json-editor` UMD bundles plus their license and pinned-version metadata. The script copies the whole directory tree.

## 5.3 What You Must Create Yourself

These are not written by the build system and must exist before the first build:

- `popup/popup.html`, `popup/popup.css`
- `settings/settings.html`, `settings/settings.css`
- `history/history.html`, `history/history.css`
- `offscreen/offscreen.html` (intentionally tiny)
- `drive-auth/drive-auth.html` (the full OAuth page)
- `icons/icon16.png`, `icons/icon48.png`, `icons/icon128.png`, `icons/icon.svg`
- `shared/theme.css`, `shared/theme-init.js`
- `player/player.html`, `player/player.css`, `player/player.js`
- `player/icons/` (any files you ship)
- `player/vendor/` (luna + LICENSE + VERSIONS.md)

A minimal `offscreen.html` is acceptable as a placeholder, but every UI page must call its own bundled `.js` via a relative `<script>`.

## 5.4 Verifying the Copy Worked

```bash
node esbuild.config.mjs --env development
find dist -type f | head -30
```

You should see all rows in `5.1` under their destination paths.

If a path is missing, check whether:

- The source path exists in the repo.
- The entry was added to `STATIC_ASSET_ENTRIES` (chapter `04`).
- File permissions let `fs.copyFileSync` read the source.

## You Should Now Have

- A `dist/` folder that mirrors the manifest's HTML references, plus the bundled player assets that the replay UI expects.
- Confirmation that every static asset listed in `5.1` exists at its destination.

Move on to [06 - Source Layers](./06-extension-source-layers.md).
