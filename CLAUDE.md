# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**GN Web Tracing** is a two-repo project: a Chrome extension (`gn-web-tracing-extension`) that records tab video, console logs, and network requests, and a companion Node.js server (`gn-web-tracing-server` at `../gn-web-tracing-server`) that stores and replays recordings. The VSCode workspace (`gn-web-tracing.code-workspace`) links both repos.

Both repos use **TypeScript** with **esbuild** for bundling.

## Development Commands

### Extension (this repo)
- `npm install` — install dependencies
- `npm run build` — compile TypeScript via esbuild → `dist/`
- `npm run watch` — watch mode, auto-rebuild on changes
- `npm run typecheck` — run `tsc --noEmit` for type checking only
- Load as unpacked extension: Chrome → `chrome://extensions` → "Load unpacked" → select this directory (after building)

### Server (`../gn-web-tracing-server`)
- `npm install` — install dependencies
- `npm run dev` — start backend with `tsx --watch` (auto-reload on TS changes, port 3000)
- `npm run dev:frontend` — watch mode for frontend (esbuild + Tailwind CSS in parallel via `concurrently`)
- `npm run build` — compile backend (`tsc`) + frontend JS (`esbuild`) + frontend CSS (`tailwindcss`)
- `npm run build:frontend` — build frontend only (JS + CSS)
- `npm start` — run production server from `dist/server.js`
- `npm run typecheck` — typecheck both backend and frontend
- No test suite, no linter configured.

## Architecture

### Extension — Chrome MV3 + TypeScript + esbuild

**Source:** `src/` → **Build output:** `dist/` (3 entry points)

```
src/types/messages.ts         → Message types shared between popup/service-worker/offscreen
src/types/recording.ts        → Data types: ConsoleEntry, NetworkEntry, WebSocketEntry, etc.
src/popup/popup.ts            → UI: start/stop recording, download ZIP, upload to server
src/background/service-worker.ts → Orchestrator: coordinates managers, handles messages
src/background/cdp-manager.ts    → Attaches Chrome DevTools Protocol to tab, captures console + network
src/background/recorder-manager.ts → Controls tab media capture via offscreen document
src/background/storage-manager.ts  → Stores captured data in memory, exports as JSON
src/background/sourcemap-resolver.ts → Decodes source maps (VLQ) to resolve minified stack traces
src/offscreen/offscreen.ts    → MediaRecorder + ZIP creation + server upload (runs in offscreen document)
```

**esbuild config:** `esbuild.config.mjs` — service-worker as ESM, popup/offscreen as IIFE. JSZip is bundled into offscreen output (no vendored lib).

**Key message flow:** Popup → Service Worker → (CdpManager + RecorderManager + StorageManager) → Offscreen Document.

All recording data lives in service worker memory — no IndexedDB or localStorage. Service worker stays alive via 24-second chrome.alarms.

CDP domains enabled: `Network`, `Runtime`, `Log`, `Debugger` (optional, for async stack traces and source maps).

### Server — Express.js + TypeScript

**Backend source:** `src/` → **Build output:** `dist/` (via tsc)
**Frontend source:** `src/frontend/` → **Build output:** `public/js/viewer.bundle.js` (via esbuild) + `public/css/viewer.css` (via Tailwind CLI)

**Frontend stack:** React + Tailwind CSS v4

```
src/server.ts                → Entry point, CORS, static files, route mounting
src/routes/upload.ts         → POST /api/recordings — receives multipart upload from extension
src/routes/recordings.ts     → GET /api/recordings/:id — returns metadata + logs as JSON
src/routes/video.ts          → GET /api/recordings/:id/video — streams WebM with Range support
src/storage/disk-store.ts    → File-based storage under /data/{hex-id}/
src/frontend/index.tsx           → React root
src/frontend/App.tsx             → Main component: data fetching, layout, tab/timeline state
src/frontend/types.ts            → Shared interfaces (ConsoleLogEntry, NetworkLogEntry, etc.)
src/frontend/app.css             → Tailwind entry + custom theme colors + custom styles
src/frontend/components/VideoPlayer.tsx   → Video playback with custom controls, timeline markers
src/frontend/components/ConsoleViewer.tsx → Console log display with filtering and CDP format parsing
src/frontend/components/NetworkViewer.tsx → Network request display, WebSocket support
```

**Two tsconfigs:** `tsconfig.json` (backend, CommonJS) and `tsconfig.frontend.json` (frontend, DOM lib, JSX). Backend uses `tsx` for dev, `tsc` for production build.

**Storage format per recording:** `data/{id}/` contains `recording.webm`, `console-logs.json`, `network-requests.json`, `websocket-logs.json` (optional), `metadata.json`.

### Data Flow

1. Extension captures via CDP events + MediaRecorder → stores in memory
2. On stop: source maps resolved, data packaged
3. User chooses download (ZIP via JSZip) or upload (multipart POST to `/api/recordings`)
4. Server saves to disk, returns view URL (`/view/:id`)
5. Viewer fetches metadata+logs via API, streams video, syncs timeline

## Key Technical Details

- Extension uses Chrome `tabCapture` API → stream passed to offscreen document for MediaRecorder
- CDP response bodies limited to text-based MIME types under 1MB
- Video codec preference: VP9 → VP8, with Opus audio
- Recording IDs are `crypto.randomBytes` hex strings validated with `/^[a-f0-9]+$/`
- Server upload limits: video 500MB, JSON fields 50MB each
- Console entries support both `console-api` (Runtime.consoleAPICalled) and `exception` (Runtime.exceptionThrown) and `browser` (Log.entryAdded) sources
- Frontend viewer is React-based with Tailwind CSS v4 for styling. Custom theme colors are defined in `src/frontend/app.css` using `@theme`. Tailwind CLI builds CSS separately from esbuild.
- Server `__dirname` in compiled code points to `dist/`, so paths to `public/` and `data/` use `path.join(__dirname, "..")`
