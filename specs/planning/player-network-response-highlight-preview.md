# Player Network Response Highlight Preview

## Context

- Request is limited to the replay player network detail UI in `player/*` and mirrored standalone assets.
- Current player only shows response text in a plain `<pre>` with optional JSON pretty-printing.
- No response preview panel exists for HTML, media, or JSON payloads.

## Goals

1. Add syntax highlighting for response bodies when mime/type indicates `js`, `html`, `css`, or `json`.
2. Add preview panels for:
   - `html`: rendered sandboxed iframe preview
   - `media`: inline image/audio/video preview when payload is previewable
   - `json`: structured preview panel with formatted content
3. Keep changes dependency-free and compatible with both extension and standalone player shells.

## Proposed Implementation

- Extend `player/player.js` with small helpers to:
  - detect preview/highlight type from mime type and URL extension
  - safely format and truncate response payloads
  - emit highlighted HTML spans for supported source types
  - generate preview metadata for HTML, media, and JSON
- Upgrade `renderNetworkDetail()` to render:
  - a "Preview" section before raw response body when preview is available
  - a highlighted raw response section for supported source types
- Add CSS in `player/player.css` for code-token colors, preview cards, iframe/media containers, and JSON preview layout.
- Sync updated `player.css` and `player.js` into `player-standalone/public/`.
- Refresh player module spec and `_sync.md`, then rebuild `graphify-out/`.

## Risks / Checks

- Must avoid executing arbitrary HTML outside a sandbox; use sandboxed iframe preview only.
- Media preview should degrade gracefully when payload is not base64 or is too large/unavailable.
- Highlighting should stay lightweight enough for large captured responses; truncate before tokenizing.
