# Drive And Player
- **Meta**: Status `Active`, Version `0.1.0`, Compliance `Documented`

## 1. Overview

This module covers authentication, Google Drive upload, replay URL generation, built-in player assets, and the optional standalone player:
- `src/background/google-drive-auth.ts`
- `src/drive-auth/drive-auth.ts`
- `player/*`
- `player-standalone/*`
- fixed replay host wiring in `src/offscreen/offscreen.ts`, `src/shared/player-host.ts`, and popup display in `src/popup/popup.ts`

## 2. Functional & Non-Functional Requirements

- Allow the user to connect/disconnect Google Drive without relying on a backend.
- Upload each recording into a dedicated Google Drive folder and return a shareable replay URL keyed by direct artifact file IDs.
- Split recorded video into `<= 32 MB` parts before upload when needed.
- Upload Google Drive artifacts with bounded parallelism instead of strictly serial transfer.
- Always return the Cloudflare-hosted standalone player URL at `https://tracing.gnas.dev/`.
- Keep auth UI resilient to popup lifetime by using a dedicated auth page.
- Keep standalone player deployable to Cloudflare Pages through a separate manual path outside the GitHub release workflow.
- Keep replay player layout user-adjustable with a draggable splitter, persisted split percentage, and switchable horizontal/vertical pane orientation.
- Allow the video pane to expand to an immersive tab-level mode inside the player surface without triggering OS/screen fullscreen.
- Keep network response inspection readable with syntax-highlighted source views for JavaScript, HTML, CSS, and JSON payloads.
- Provide inline response preview panels for HTML, media, and JSON artifacts inside the network detail inspector.
- Include recording-specific metadata in the player title so multiple open replay tabs remain distinguishable.

## 3. Data Models & APIs

- `GoogleDriveAuth.getAuthToken()` returns a usable token or `null`.
- upload creates one Drive folder per recording containing `metadata.json`, `manifest.json`, optional log JSON files, and one or more `video.part-XXX.webm` files.
- `manifest.json` is the storage layout source of truth; it records schema version, folder ID, video mime type/parts, and which optional artifacts exist.
- replay links now use `?videos=<video-file-id[,more-video-file-ids]>&metadata=<file-id>` plus optional `console`, `network`, and `websocket` query params.
- standalone player loads artifacts directly from the file IDs in the query string and does not require Drive folder listing or a Drive API key for replay.
- standalone player proxies artifact downloads through a same-origin Cloudflare Pages Function at `/api/drive` to avoid browser CORS/CORP failures against public Google Drive download hosts.

## 4. Business Rules

- Chrome uses `chrome.identity.getAuthToken`; Edge uses `launchWebAuthFlow` and stores a verified access token locally.
- disconnect always attempts revocation but returns a success-style response even when the token is already invalid.
- every recording folder is made world-readable, and each uploaded Drive file is also made world-readable before being referenced by the player.
- replay links always target the full Cloudflare Pages player host URL directly.
- the auth page is a first-class surface that can both start auth and react to service-worker state updates.
- standalone player is not the system of record for assets; it mirrors `player/` runtime logic through the sync script and wrapper adapters.
- release automation expects both npm workspaces to have committed lockfiles so GitHub Actions can run `npm ci` at the repo root and inside `player-standalone/`.
- tag-based GitHub releases only build the extension and publish the zip artifact; they do not invoke Cloudflare deploy steps for the standalone player.
- if video exceeds the upload limit, offscreen upload slices the final recording blob into ordered byte chunks and the player reassembles them locally before playback.
- popup upload status must surface aggregate transferred bytes and percent throughout the Drive upload flow.
- upload hard-fails when folder creation, metadata, manifest, or any video part upload fails; console/network/websocket uploads are best-effort and omitted from the manifest when they fail.
- player loading must surface transferred bytes and percent while downloading artifacts, and video part downloads should run in parallel rather than sequentially.
- player layout preferences are stored per-origin in `localStorage` under a single player UI state entry and restored on load.
- pane resize is clamped to keep both panes visible; the same persisted percent is reused when switching between horizontal and vertical layout modes.
- video "fullscreen" is implemented as an in-tab immersive player mode that hides the header and logs pane instead of using browser/OS fullscreen APIs.
- network detail derives response presentation from mime type plus URL extension, then renders either highlighted source, an inline preview, or both.
- HTML preview uses a sandboxed iframe, media preview uses inline data URLs when captured payloads are base64-backed, and JSON preview combines a summary card with formatted source.
- player title derives a short label from metadata URL plus recording timestamp and applies it to both the visible header and `document.title`.

## 5. Constraints & Assumptions

- uploads require publicly shareable Drive permissions for replay links to work outside the extension.
- standalone mode depends only on direct public file download behavior for the artifact IDs embedded in the replay URL.
- standalone mode assumes the Cloudflare Pages deployment includes the `/api/drive` proxy function so the browser never fetches Drive artifacts cross-origin.
- extension build and standalone player build are separate pipelines.
- built-in player HTML and standalone wrapper HTML must stay markup-compatible because only `player.css` and `player.js` are synced automatically into `player-standalone/public/`.
- response preview intentionally stays dependency-free and lightweight; syntax highlighting is implemented in local player runtime helpers rather than external libraries.
- manual Cloudflare Pages deployment expects project `gn-tracing-player`, root base path `/`, and secrets `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`.
- local deploys can source root `.env` / `.env.example` with `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_PAGES_PROJECT`, `PLAYER_HOST_URL`, and `VITE_BASE_PATH`.

## 6. Relationships

- consumes recording artifacts from `recording-runtime`
- shares replay payload schema with built-in player and standalone player
- depends on `shared/api-conventions` for Chrome identity + Drive API assumptions
- exposes fixed player-host information to popup UX and release automation

## 7. Related Decisions

- auth is moved out of the popup into `drive-auth.html` to avoid popup closure interrupting OAuth.
- standalone replay distribution is standardized on Cloudflare Pages instead of popup-configured hosts.
- tag release automation delegates only extension build/artifact packaging to root `package.json` scripts; standalone Cloudflare deploy is intentionally excluded from release CI.

## 8. Changelog

- `2026-04-23`: Network response detail now supports syntax highlighting for JavaScript/HTML/CSS/JSON and adds inline preview panels for HTML, media, and JSON payloads.
- `2026-04-23`: Player title now includes a short metadata-derived label so users can distinguish recordings when multiple replay tabs are open.
- `2026-04-23`: Replay player now supports draggable pane resizing, persisted layout percent in `localStorage`, horizontal/vertical orientation switching, and in-tab immersive video expansion in both extension and standalone shells.
- `2026-04-23`: Drive upload now runs with bounded parallelism and byte-level popup progress; player loading now reports byte-level progress and downloads video parts in parallel.
- `2026-04-23`: Upload keeps folder-scoped Drive storage and `manifest.json`, but replay links now pass direct artifact file IDs via `videos`, `metadata`, `console`, `network`, and `websocket`; standalone playback no longer depends on folder listing.
- `2026-04-23`: Standalone playback now routes Drive artifact downloads through a same-origin Pages Function proxy to avoid `Failed to fetch` errors from browser CORS/CORP enforcement.
- `2026-04-23`: Tag-based release CI no longer deploys the standalone player to Cloudflare; it only builds and publishes the extension artifact, while player deploy stays manual.
- `2026-04-23`: Replay links were fixed to `https://tracing.gnas.dev/` and standalone deployment was standardized on Cloudflare Pages tag releases.
- `2026-04-23`: Local Cloudflare Pages deploy was executed after provisioning project `gn-tracing-player`; root env files now carry deploy variables for the player release flow.
- `2026-04-23`: Initial spec extracted from current implementation.
