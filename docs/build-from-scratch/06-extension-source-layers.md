---
title: "06 - Extension Source Layers"
description: "The src/, popup/, settings/, history/, offscreen/, drive-auth/, shared/ source tree and what each file owns."
type: build
status: active
tags: ["build", "source", "architecture"]
related:
  - "./04-extension-build-esbuild.md"
  - "./05-extension-static-assets.md"
  - "./07-standalone-player.md"
---

# 06 - Extension Source Layers

## Meta

- Goal: create the runtime source tree that chapter `04` bundles into `dist/`.
- Verification: `node esbuild.config.mjs --env development` compiles every entry without missing-file errors.

## 6.1 The Tree at a Glance

```
src/
├── background/                service worker
│   ├── service-worker.ts      composition root (orchestrates capture, auth, upload)
│   ├── cdp-manager.ts         chrome.debugger collector (console, network, WebSocket)
│   ├── google-drive-auth.ts   Chromium-wide Google OAuth
│   ├── storage-manager.ts     chrome.storage.session + .local state
│   ├── settings-store.ts      capture / privacy / upload settings + profiles
│   ├── capture-environment.ts normalized capture environment metadata
│   ├── message-router.ts      UI <-> worker message dispatch
│   ├── recorder-manager.ts    recorder lifecycle over the offscreen document
│   ├── upload-orchestrator.ts Drive upload sequencing
│   ├── sourcemap-resolver.ts  inline + external source-map loading
│   └── update-checker.ts      GitHub Releases version compare
├── content/                   injected into the recorded tab
│   ├── recording-events.ts    user-event capture (MAIN / ISOLATED worlds)
│   ├── in-page-capture.ts     entry: wires in-page-capture-core
│   ├── in-page-capture-core.ts non-CDP instrumentation core
│   └── in-page-relay.ts       postMessage bridge to the service worker
├── popup/                     toolbar UI
│   └── popup.ts
├── settings/                  settings page UI
│   └── settings.ts
├── history/                   upload-history page UI
│   └── history.ts
├── offscreen/                 offscreen document logic
│   └── offscreen.ts
├── drive-auth/                oauth standalone page logic
│   └── drive-auth.ts
├── shared/                    cross-surface helpers
│   ├── privacy-redaction.ts   client-side redaction across evidence types
│   ├── luna-adapter.ts        vendored luna renderer wrappers
│   ├── upload-history-ui.ts   local-history rendering
│   ├── dom-artifact.ts        DOM snapshot artifact helpers
│   ├── storage-artifact.ts    storage snapshot artifact helpers
│   ├── recording-target.ts    tab target validation
│   ├── player-host.ts         external player URL builder
│   ├── google-drive-folder.ts Drive folder resolution
│   └── theme.ts               theme toggle helper
└── types/                     shared contracts
    ├── messages.ts            ServiceWorkerMessage, MessageResponse, RecordingStatus
    └── recording.ts           ConsoleEntry, NetworkEntry, WebSocketEntry, etc.
```

## 6.2 Composition-Root Contracts

The service worker is the composition root. It:

1. Owns the recording session id and lifecycle state.
2. Loads settings via `settings-store.ts` before any capture decision.
3. Validates the target tab via `shared/recording-target.ts`.
4. Creates a `StorageManager` and a `CdpManager` instance.
5. Asks `recorder-manager.ts` to spin up the offscreen document with `MediaRecorder`.
6. Injects the appropriate content script via `chrome.scripting.executeScript` (using the `manifest`'s `scripting` permission).
7. Listens for status requests from popup and surfaces state via `chrome.storage.session`.

The popup and settings pages never speak to the manager classes directly; every interaction is a message routed by `message-router.ts`.

## 6.3 Why This Shape

- The MV3 service worker is event-driven and can be terminated between events. Keeping state outside the worker (in `chrome.storage.session`) is mandatory.
- `chrome.tabCapture` is only available in extension pages, not service workers, so the offscreen document is the only legal home for `MediaRecorder` and Drive uploads.
- User-facing UIs (popup, settings, history, drive-auth, the standalone player) are thin clients that render service-worker-owned state. The shared `types/messages.ts` is the contract that keeps them in sync.

## 6.4 Contracts to Define First

`src/types/messages.ts` is the entry point. It defines:

- `ServiceWorkerMessage` — the union of every action the worker accepts (`START_RECORDING`, `STOP_RECORDING`, `GET_STATUS`, `GET_UPLOAD_STATE`, etc.).
- `MessageResponse<T>` — discriminated response with success / error.
- `RecordingStatus` — the live status object mirrored into `chrome.storage.session`.
- `UploadSettings`, `PrivacyRedactionSettings` — wire-format DTOs.
- `RecordingSessionSummary` — surfaced in popup and history.

`src/types/recording.ts` defines the artifact entry shapes:

- `ConsoleEntry` — `level`, `args`, `timestamp`, optional `stackTrace`.
- `NetworkEntry` — request/response pairs, headers, bodies (when allowed).
- `WebSocketEntry` — frames, with text payloads only when consent is on.
- `StorageSnapshot` — snapshot of `localStorage`, `sessionStorage`, cookies.

Every chapter that ships evidence writes a stream of these entries into the in-memory artifact map.

## 6.5 Building Skeletons

For chapter `12` to load the extension, every entry point must exist as a stub that does not throw on import. A minimal `service-worker.ts`:

```ts
import { setupMessageRouter } from "./message-router";
import { loadSettingsStore } from "./settings-store";

chrome.runtime.onInstalled.addListener(() => {
  console.log("gn-tracing installed");
});

void loadSettingsStore().then(() => setupMessageRouter());
```

A minimal `popup.ts`:

```ts
document.querySelector("#start")?.addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "START_RECORDING" });
});
```

You can wire the real behavior incrementally; the build does not require every feature on the first run.

## 6.6 Content Script Worlds

The recording-events content script uses both `MAIN` and `ISOLATED` worlds (via `chrome.scripting.executeScript({ world: ... })`):

- `MAIN` — observes DOM-level events, including composable event handlers.
- `ISOLATED` — relays the events back to the service worker over `chrome.runtime.connect({ name: "recording-events" })`.

`in-page-capture-core.ts` collects the same evidence the CDP path produces, but via direct `window`/`document` instrumentation; the chapter `04` content-script bundle `in-page-capture.js` is the opt-in fallback when the user disables the `debugger` banner.

## 6.7 Shared Code Is Shared

Files under `src/shared/` are imported by both the extension UIs and the standalone player when the player runs inside the extension (via `chrome.runtime.getURL("player/player.html")`). Treat them as API-stable; changes here touch multiple surfaces.

## You Should Now Have

- Every file in `6.1` exists as a stub.
- `node esbuild.config.mjs --env development` produces `dist/background/service-worker.js` plus all entry-point IIFEs.
- `dist/content/recording-events.js`, `in-page-capture.js`, `in-page-relay.js` exist.

Move on to [07 - Standalone Player](./07-standalone-player.md).
