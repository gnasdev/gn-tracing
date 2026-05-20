# GN Tracing

GN Tracing is a Chrome and Edge extension that records one browser tab and packages the useful debugging evidence into a shareable replay.

It captures:

- tab video and audio
- console logs and runtime errors
- network requests and responses
- WebSocket activity
- an optional Google Drive upload with a replay link

## Screenshots

### Extension popup

![GN Tracing popup recording controls](./store-assets/screenshots/01-popup-recording-controls.png)

### Privacy and Drive settings

![GN Tracing privacy and Drive settings](./store-assets/screenshots/02-popup-privacy-and-drive-settings.png)

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

If Google Drive is connected, GN Tracing uploads automatically after recording stops.

## Install

GN Tracing is distributed as a packaged release from this repository.

1. Download the latest release `.zip`.
2. Extract it.
3. Open `chrome://extensions` or `edge://extensions`.
4. Turn on `Developer mode`.
5. Click `Load unpacked`.
6. Select the extracted `gn-tracing-extension-v<version>/` folder.

## Replay Links

Uploaded sessions open in the hosted player at [tracing.gnas.dev](https://tracing.gnas.dev/).

The player lets you review the video together with console, network, and WebSocket data. You can search, filter, inspect request details, copy cURL, and copy available response content.

## Privacy Controls

Sensitive request and response headers are redacted by default.

Request bodies, response bodies, and WebSocket message payloads are captured only when enabled in the popup privacy settings. Response body capture is limited to supported text-based content types and about `1 MB` per response.

## Limits

- Records one tab at a time.
- Cannot record `chrome://` pages.
- Keeps unfinished recording data in extension memory until upload.
- A browser or extension restart can interrupt an unfinished local recording.

## Developers

See [DEVELOPER.md](./DEVELOPER.md) for local setup, architecture notes, build tasks, and release guidance.

## License

GPL-3.0-or-later. See [LICENSE](./LICENSE).
