# GN Web Tracing (Chrome Extension)

A Chrome Manifest V3 extension that records tab video, console logs, and network requests for debugging and session replay.

<p align="center">
  <img src="icons/icon128.png" alt="GN Web Tracing logo" width="128" height="128">
</p>

## Features

- **Tab Video Recording** — Captures tab video (VP9/VP8) and audio (Opus) at up to 1920x1080 @ 30fps using `chrome.tabCapture`
- **Console Logging** — Captures all console API calls (`log`, `debug`, `info`, `warn`, `error`), uncaught exceptions with stack traces, and browser logs via Chrome DevTools Protocol
- **Network Requests** — Records HTTP/HTTPS requests and responses including headers, POST data, response bodies (text-based MIME types < 1MB), timing data (DNS, SSL, connect, wait), redirects, and errors
- **WebSocket Support** — Tracks WebSocket connections, sent/received frames, opcodes, and payloads
- **Source Map Resolution** — Automatically fetches and decodes source maps (VLQ) to resolve minified stack traces back to original source locations
- **ZIP Download** — Package recording (video + JSON logs + metadata) as a ZIP file
- **Server Upload** — Upload recordings to the companion [gn-web-tracing-server](https://github.com/user/gn-web-tracing-server) for viewing and sharing

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
│                             └────────────────────────┘  │
│                                        │                 │
│                                        ▼                 │
│                             ┌────────────────────────┐  │
│                             │  Offscreen Document    │  │
│                             │  (MediaRecorder + ZIP  │  │
│                             │   + server upload)     │  │
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
│   └── sourcemap-resolver.ts    # VLQ decoder, minified → original source mapping
├── popup/
│   └── popup.ts                 # UI: start/stop, download ZIP, upload to server
└── offscreen/
    └── offscreen.ts             # MediaRecorder, ZIP creation (JSZip), server upload
```

## Getting Started

### Prerequisites

- Node.js (v18+)
- Google Chrome

### Install & Build

```bash
npm install
npm run build
```

### Load Extension in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the root directory of this project (after building)

### Development

```bash
npm run watch    # Auto-rebuild on source changes
npm run typecheck # Type checking only (no emit)
```

## Usage

1. Click the GN Web Tracing extension icon in Chrome toolbar
2. Click **Start Recording** — the extension captures video, console logs, and network requests from the active tab
3. Click **Stop Recording** when done
4. Choose one of:
   - **Download ZIP** — saves a ZIP file with video (`.webm`), console logs, network requests, and metadata as JSON
   - **Upload to Server** — sends the recording to a configured gn-web-tracing-server instance for viewing in a web UI

### Server Configuration

Click the gear icon in the popup to set the server URL (e.g., `http://localhost:3000`). The URL is persisted across sessions.

## Chrome Permissions

| Permission | Purpose |
|-----------|---------|
| `tabCapture` | Capture tab audio/video stream |
| `offscreen` | Create offscreen document for MediaRecorder (MV3 requirement) |
| `debugger` | Attach Chrome DevTools Protocol for console + network capture |
| `activeTab` | Access active tab information |
| `downloads` | Download ZIP files |
| `storage` | Persist server URL preference |
| `alarms` | Keep service worker alive during recording (24s interval) |
| `<all_urls>` | Host permission required for CDP access to any page |

## Technical Details

- **All recording data lives in service worker memory** — no IndexedDB or localStorage
- Service worker kept alive via `chrome.alarms` (24-second interval) to prevent dormancy during long recordings
- CDP domains enabled: `Network`, `Runtime`, `Log`, `Debugger` (for async stack traces and source maps)
- Response bodies limited to text-based MIME types under 1MB
- Video codec preference: VP9 → VP8 fallback, with Opus audio
- Source map VLQ decoding implemented from scratch (no external library)
- Build: esbuild with ESM format for service worker, IIFE for popup/offscreen

## Dependencies

- **[jszip](https://www.npmjs.com/package/jszip)** — ZIP file creation for recording export
- **[@types/chrome](https://www.npmjs.com/package/@types/chrome)** — Chrome extension API types (dev)
- **[esbuild](https://www.npmjs.com/package/esbuild)** — TypeScript bundler (dev)
- **[typescript](https://www.npmjs.com/package/typescript)** — Type checking (dev)

## Related

- **[gn-web-tracing-server](../gn-web-tracing-server)** — Companion server for storing and viewing recordings

## License

Private
