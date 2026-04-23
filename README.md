# GN Tracing (Chrome Extension)

A Chrome/Edge Manifest V3 extension that records tab video, console logs, and network requests for debugging and session replay.

<p align="center">
  <img src="icons/icon128.png" alt="GN Tracing logo" width="128" height="128">
</p>

## Features

- **Tab Video Recording** — Captures tab video (VP9/VP8) and audio (Opus) at up to 1920x1080 @ 30fps using `chrome.tabCapture`. The recording process produces properly-cued WebM files allowing accurate seeking.
- **Console Logging** — Captures all console API calls (`log`, `debug`, `info`, `warn`, `error`), uncaught exceptions with stack traces, and browser logs via Chrome DevTools Protocol
- **Network Requests** — Records HTTP/HTTPS requests and responses including headers, POST data, response bodies (text-based MIME types < 1MB), timing data (DNS, SSL, connect, wait), redirects, and errors
- **WebSocket Support** — Tracks WebSocket connections, sent/received frames, opcodes, and payloads
- **Source Map Resolution** — Automatically fetches and decodes source maps (VLQ) to resolve minified stack traces back to original source locations
- **Google Drive Upload** — Upload recordings directly to Google Drive with shareable links via a dedicated authentication page (no server required)
- **Standalone Replay Player** — Uploaded recordings open in the fixed Cloudflare Pages player at `https://tracing.gnas.dev/`, which loads Drive artifacts through a same-origin `/api/drive` proxy to avoid browser CORS/CORP issues


## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Chrome Extension                     │
│                                                          │
│  ┌──────────┐    messages    ┌────────────────────────┐  │
│  │  Popup   │ ─────────────►│   Service Worker       │  │
│  │  (UI)    │◄───────────── │                        │  │
│  └──────────┘               │  ┌──────────────────┐  │  │
│                             │  │  CDP Manager     │  │  │
│                             │  │  (console+network│  │  │
│                             │  └──────────────────┘  │  │
│                             │  ┌──────────────────┐  │  │
│                             │  │ Recorder Manager │  │  │
│                             │  │ (video capture)  │  │  │
│                             │  └──────────────────┘  │  │
│                             │  ┌──────────────────┐  │  │
│                             │  │ Storage Manager  │  │  │
│                             │  │ (in-memory data) │  │  │
│                             │  └──────────────────┘  │  │
│                             │  ┌──────────────────┐  │  │
│                             │  │SourceMap Resolver│  │  │
│                             │  └──────────────────┘  │  │
│                             │  ┌──────────────────┐  │  │
│                             │  │ Google Drive Auth│  │  │
│                             │  └──────────────────┘  │  │
│                             └────────────────────────┘  │
│                                        │                 │
│                                        ▼                 │
│                             ┌────────────────────────┐  │
│                             │  Offscreen Document    │  │
│                             │  (MediaRecorder +      │  │
│                             │   Drive upload)        │  │
│                             └────────────────────────┘  │
│                                        │                 │
│                             ┌────────────────────────┐  │
│                             │  Drive Auth Page       │  │
│                             │  (Google OAuth flow)   │  │
│                             └────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### Source Structure

```
src/
├── types/
│   ├── messages.ts              # Message types between popup/service-worker/offscreen
│   └── recording.ts             # Data types: ConsoleEntry, NetworkEntry, WebSocketEntry
├── background/
│   ├── service-worker.ts        # Orchestrator: coordinates managers, handles messages
│   ├── cdp-manager.ts           # Chrome DevTools Protocol: console + network capture
│   ├── recorder-manager.ts      # Tab media capture via offscreen document
│   ├── storage-manager.ts       # In-memory data storage, JSON export
│   ├── sourcemap-resolver.ts    # VLQ decoder, minified → original source mapping
│   └── google-drive-auth.ts     # Google Drive OAuth2 authentication flow
├── shared/
│   └── player-host.ts           # Fixed standalone player host URL builder
├── popup/
│   └── popup.ts                 # UI: start/stop, Drive upload, auth status, replay link display
├── offscreen/
│   └── offscreen.ts             # MediaRecorder and Drive upload
└── drive-auth/
    └── drive-auth.ts            # Dedicated Google Drive auth page logic

player-standalone/
├── src/                         # Standalone app bootstrap + Drive adapter
├── public/                      # Synced player runtime assets
├── functions/api/drive.js       # Cloudflare Pages proxy for Drive artifact downloads
└── deploy.sh                    # Player deploy entrypoint for local and CI release flow
```

## Getting Started

### Prerequisites

- Node.js (v18+)
- Google Chrome or Microsoft Edge

### Install & Build

```bash
npm install
npm run build
```

The extension is not loadable from a fresh checkout until `npm run build` creates the compiled files under `dist/`.
If Chrome shows `Could not load background script ''` or `Could not load manifest`, the usual cause is that `dist/background/service-worker.js` does not exist yet.

If you want the extension and standalone player assets aligned locally, use:

```bash
npm run build:all
```

### Load Extension in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `dist/` directory from this project (after building)

### Development

```bash
npm run watch    # Auto-rebuild on source changes
npm run typecheck # Type checking only (no emit)
npm run watch:all # Extension watch + standalone player dev server
```

## Usage

1. Click the GN Tracing extension icon in Chrome toolbar
2. Click **Start Recording** — the extension captures video, console logs, and network requests from the active tab
3. Click **Stop Recording** when done
4. Choose one of:
   - **Upload to Google Drive** — uploads directly to your Google Drive and returns a replay URL on `https://tracing.gnas.dev/`


### Google Drive Setup

To enable Google Drive upload:

1. **Use the built-in OAuth configuration:**
   - The extension already ships with a Google OAuth Client ID in `manifest.template.json`.
   - Rebuild after changes:
     ```bash
     npm run build
     ```
   - If you need a different OAuth app later, update the `oauth2.client_id` value in `manifest.template.json`

2. **Connect Google Drive:**
   - Click the **Connect** button in the extension popup
   - A dedicated authentication page will open in a new tab
   - Click **Continue with Google** and authorize the extension
   - Once connected, you can upload recordings directly to Drive

> **Note:** The OAuth flow happens in a dedicated page instead of the popup to prevent authentication interruptions when the popup closes.

### Player Host

Uploaded recordings always open in the standalone player hosted at `https://tracing.gnas.dev/`.
The extension returns the full Cloudflare Pages player URL directly.
Replay URLs use direct Drive artifact file IDs in the query string: `videos`, `metadata`, and optional `console`, `network`, `websocket`.

### Standalone Player

- `player-standalone/public/player.js` is synced from the extension player runtime via `npm run player:sync`
- standalone playback fetches Drive artifacts through `player-standalone/functions/api/drive.js`
- local player workflows:
  - `npm run player:dev`
  - `npm run player:build`
  - `npm run player:deploy`

### Release Flow

- Push a tag matching `v*` to trigger `.github/workflows/release.yml`
- The deploy flow is defined in root `package.json` scripts:
  - `npm run release:deploy` builds the extension and deploys the standalone player to Cloudflare Pages
  - `npm run release:artifact` zips `dist/` into a release artifact
  - `npm run release:ci` runs the full release flow used by GitHub Actions
- CI also installs `player-standalone/` dependencies, then calls the root release flow
- The workflow only installs dependencies, runs `npm run release:ci`, and attaches the generated zip to the GitHub release
- Required GitHub Actions secrets:
  - `CLOUDFLARE_API_TOKEN`
  - `CLOUDFLARE_ACCOUNT_ID`

## Chrome Permissions

| Permission | Purpose |
|-----------|---------|
| `tabCapture` | Capture tab audio/video stream |
| `offscreen` | Create offscreen document for MediaRecorder (MV3 requirement) |
| `debugger` | Attach Chrome DevTools Protocol for console + network capture |
| `activeTab` | Access active tab information |
| `storage` | Persist Google Drive auth state used by the extension runtime |
| `alarms` | Keep service worker alive during recording (24s interval) |
| `identity` | OAuth 2.0 authentication for Google Drive upload |
| `<all_urls>` | Host permission required for CDP access to any page |

## Technical Details

- **All recording data lives in service worker memory** — no IndexedDB or localStorage
- Service worker kept alive via `chrome.alarms` (24-second interval) to prevent dormancy during long recordings
- CDP domains enabled: `Network`, `Runtime`, `Log`, `Debugger` (for async stack traces and source maps)
- Response bodies limited to text-based MIME types under 1MB
- Video codec preference: VP9 → VP8 fallback, with Opus audio. MediaRecorder is configured without `timeslice` to ensure WebM files contain complete Cues for accurate timeline seeking, and features synchronized `stopCapture` logic to prevent race conditions during file finalization.
- Source map VLQ decoding implemented from scratch (no external library)
- Build: esbuild with ESM format for service worker, IIFE for popup/offscreen

## Dependencies

- **[@types/chrome](https://www.npmjs.com/package/@types/chrome)** — Chrome extension API types (dev)
- **[esbuild](https://www.npmjs.com/package/esbuild)** — TypeScript bundler (dev)
- **[typescript](https://www.npmjs.com/package/typescript)** — Type checking (dev)

## License

Private
