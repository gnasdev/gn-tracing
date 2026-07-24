# GN Tracing

GN Tracing is a Chromium-based browser extension that records one browser tab and packages the useful debugging evidence into a shareable replay. It works on Chrome, Edge, Brave, Vivaldi, Opera, and other Chromium-based browsers.

It captures:

- tab video and audio
- console logs and runtime errors
- network requests and responses
- WebSocket activity
- optional storage snapshots (localStorage, sessionStorage, cookies) and static DOM snapshots
- an optional upload to your cloud storage (Google Drive or Dropbox) with a replay link

## Screenshots

### Extension popup

![GN Tracing popup recording controls](./store-assets/screenshots/01-popup-recording-controls.png)

### Privacy and cloud storage settings

![GN Tracing privacy and cloud storage settings](./store-assets/screenshots/02-popup-privacy-and-drive-settings.png)

### Replay player

![GN Tracing replay inspector](./store-assets/screenshots/04-player-replay-inspector.png)

### Upload history

![GN Tracing upload history page](./store-assets/screenshots/05-upload-history-page.png)

## When to use it

Use GN Tracing when a bug is easier to show than explain, especially when engineers need more than a screen recording.

Good fits:

- UI bugs across longer flows
- API failures that need request and response context
- WebSocket issues where message timing matters
- QA, support, product, and engineering handoffs

## Quick Start

1. Install the extension.
2. Open the tab you want to record.
3. Click the `GN Tracing` extension icon.
4. Click `Start Recording`.
5. Reproduce the issue.
6. Click `Stop Recording`.
7. Open or share the replay link after upload.

If cloud storage is connected, GN Tracing uploads automatically after recording stops.

## Install

GN Tracing is distributed as a packaged release from this repository.

1. Download the latest release `.zip`.
2. Extract it.
3. Open your browser's extensions page (`chrome://extensions`, `edge://extensions`, or equivalent).
4. Turn on `Developer mode`.
5. Click `Load unpacked`.
6. Select the extracted `gn-tracing-extension-v<version>/` folder.

## Replay Links

Uploaded sessions open in the hosted player at [tracing.gnas.dev](https://tracing.gnas.dev/).

The player lets you review the video together with console, network, and WebSocket data. You can search, filter, inspect request details, copy cURL, and copy available response content.

## Privacy Controls

Sensitive request and response headers are redacted by default.

Request bodies, response bodies, and WebSocket message payloads are captured only when enabled in the popup privacy settings. Response body capture is limited to supported text-based content types and about `1 MB` per response.

### Storage and DOM capture (opt-in)

Two additional evidence sources are available in Settings. Both default to **off** and ship with redaction **on**, so nothing extra is captured until you turn it on:

- `captureStorage` — snapshots `localStorage`, `sessionStorage`, and cookies at recording start and stop, packaged as `storage.json` and shown in the player `Storage` tab with a start↔stop diff. `redactStorageValues` (default on) replaces values whose key matches a sensitive pattern (password, token, secret, and similar) with a redacted placeholder before the snapshot is buffered.
- `captureDomSnapshots` — captures a static DOM tree at start, stop, and key marker events (not a continuous recording), packaged as `dom.json` and shown in the player `Elements` tab. `redactDomTextContent` (default on) masks text and attribute values for nodes matching your DOM mask selectors. Oversized snapshots are reduced or skipped, and any skipped capture is noted in the recording's privacy limitations.

Because both expand the captured surface of personal data, keep them off unless a bug genuinely depends on stored state or DOM structure, and prefer the default redaction.

### Capture mode

`captureMode` selects how evidence is collected and defaults to `"cdp"`:

- `"cdp"` — full-fidelity capture through the Chrome Debugger Protocol. The browser shows a "debugging this tab" banner while recording.
- `"in-page"` — opt-in, lower-fidelity capture that injects in-page instrumentation instead of attaching the debugger, so no debugging banner appears. Trade-offs: no cross-origin response bodies and no real source maps, and a page's Content Security Policy can block the injection. These limitations are recorded in the recording's privacy summary, and if CSP blocks injection the recording recommends switching back to `"cdp"`.

### Third-party components and attribution

The replay player renders objects and JSON with vendored, prebuilt [luna](https://github.com/liriliri/luna) components (`luna-object-viewer`, `luna-json-editor`) under `player/vendor/luna/`. These are MIT-licensed; the upstream license is kept at [`player/vendor/luna/LICENSE`](./player/vendor/luna/LICENSE) and pinned versions are recorded in `player/vendor/luna/VERSIONS.md`. The player falls back to its built-in renderers if a component is unavailable.

## Limits

- Records one tab at a time.
- Cannot record browser system pages, extension pages, Chrome Web Store pages, DevTools/internal URLs, or tabs without a normal `http:`, `https:`, or `file:` URL.
- Keeps unfinished recording data in extension memory until upload.
- A browser or extension restart can interrupt an unfinished local recording.
- On non-Chrome Chromium browsers, some OAuth access tokens expire after approximately one hour and may require silent refresh or reconnection depending on the provider. Brave Shields may block the OAuth popup; disable Shields for the extension page if cloud storage connect fails.

## Developers

See [DEVELOPER.md](./DEVELOPER.md) for local setup, architecture notes, build tasks, and release guidance.

## License

GPL-3.0-or-later. See [LICENSE](./LICENSE).
