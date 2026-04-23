# GN Tracing Specs Overview

- **Status**: Active
- **Version**: 0.1.0

## Goal

GN Tracing is a Chrome/Edge Manifest V3 extension for capturing a browser tab session as synchronized artifacts:
- tab video/audio recording
- console logs and exception traces
- network requests, responses, and WebSocket traffic
- optional Google Drive upload with a player URL for replay

## In Scope

- MV3 extension runtime under `src/`, `popup/`, `offscreen/`, `drive-auth/`, `player/`
- capture orchestration via service worker, offscreen document, and Chrome Debugger API
- Google Drive authentication and upload flow
- built-in replay player and standalone player integration under `player-standalone/`
- build pipeline that emits the unpacked extension into `dist/`

## Out Of Scope

- backend/server-side storage or processing
- local persistence for captured recording payloads beyond in-memory runtime state
- backward compatibility with removed modules or deprecated message contracts
- non-Chromium browser implementations beyond the current Chrome/Edge-specific handling already in code

## Current Scope Guard

The current codebase is centered on session capture and replay distribution. New specs should stay within:
- browser capture/runtime behavior
- upload/share flows
- player hosting and playback integration
- build/distribution mechanics for the extension and standalone player
