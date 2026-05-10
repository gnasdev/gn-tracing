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
- Upload each recording into a dedicated Google Drive folder and return a shareable replay URL keyed by the uploaded `recording-index.json` file ID.
- Split recorded video into `<= 32 MB` parts before upload when needed.
- Upload Google Drive artifacts with bounded parallelism instead of strictly serial transfer.
- Always return the Cloudflare-hosted standalone player URL at `https://tracing.gnas.dev/`.
- Keep auth UI resilient to popup lifetime by using a dedicated auth page.
- Keep standalone player deployable to Cloudflare Pages through a separate manual path outside the GitHub release workflow.
- Keep GitHub Releases focused on the manual unpacked install zip.
- Keep replay player layout user-adjustable with a draggable splitter, persisted split percentage, and switchable horizontal/vertical pane orientation.
- Allow the video pane to expand to an immersive tab-level mode inside the player surface without triggering OS/screen fullscreen.
- Keep network response inspection readable with syntax-highlighted source views for JavaScript, HTML, CSS, and JSON payloads.
- Provide inline response preview panels for HTML, media, and JSON artifacts inside the network detail inspector.
- Include recording-specific metadata in the player title so multiple open replay tabs remain distinguishable.
- Show a usage/intro landing state when the player opens without replay query params, including GitHub and contribution guidance.
- Surface GitHub and contribution entry points inside the extension popup, without exposing the fixed player host as popup UI.
- Keep extension runtime state mirrored into a popup/auth snapshot without forcing a live Google Drive verification on every state write.
- Recover popup-visible recording state after service-worker restart by reconciling the last session snapshot with the offscreen capture state when possible.

## 3. Data Models & APIs

- `GoogleDriveAuth.getAuthToken()` returns a usable token or `null`.
- upload creates one Drive folder per recording containing `metadata.json`, `manifest.json`, `recording-index.json`, optional log JSON files, and one or more `video.part-XXX.webm` files.
- `manifest.json` is the storage layout source of truth; it records schema version, folder ID, video mime type/parts, and which optional artifacts exist.
- `recording-index.json` is the public replay entrypoint; it stores the manifest, metadata, optional artifact, and video-part file IDs needed by the player.
- replay links use a single recording index file ID path, for example `https://tracing.gnas.dev/<index-file-id>`.
- the player also retains a legacy direct-file query parser for debugging or older links that still pass `videos`, `metadata`, `console`, `network`, and `websocket` params.
- standalone player loads the index first, then loads artifacts directly from the file IDs listed by that index and does not require Drive folder listing or a Drive API key for replay.
- standalone player proxies artifact downloads through a same-origin Cloudflare Pages Function at `/api/drive` to avoid browser CORS/CORP failures against public Google Drive download hosts.

## 4. Business Rules

- Chrome uses `chrome.identity.getAuthToken`; Edge uses `launchWebAuthFlow` and stores a verified access token locally.
- disconnect always attempts revocation but returns a success-style response even when the token is already invalid.
- every recording folder is made world-readable, and each uploaded Drive file is also made world-readable before being referenced by the player.
- replay links always target the full Cloudflare Pages player host URL directly.
- the auth page is a first-class surface that can both start auth and react to service-worker state updates.
- standalone player is not the system of record for assets; it mirrors `player/` runtime logic through the sync script and wrapper adapters.
- release automation expects both npm workspaces to have committed lockfiles so GitHub Actions can run `npm ci` at the repo root and inside `player-standalone/`.
- tag-based GitHub releases build the extension and publish `gn-tracing-extension-${tag}.zip` for manual unpacked installation; they do not publish CRX/update XML artifacts or invoke Cloudflare deploy steps for the standalone player.
- if video exceeds the upload limit, offscreen upload slices the final recording blob into ordered byte chunks and the player reassembles them locally before playback.
- popup upload status must surface both aggregate transferred bytes/percent and per-file progress rows throughout the Drive upload flow.
- player loading must surface both aggregate transferred bytes/percent and per-file progress rows for the recording index, metadata, optional artifacts, manifest, and each video part.
- upload progress now measures artifact payload bytes rather than raw multipart HTTP body bytes so aggregate totals match the recording artifacts shown to the user.
- service worker must re-hydrate Google Drive auth status on startup/install so popup state stays correct after extension reloads.
- service worker now treats Google Drive connectivity as a separately refreshed cache; snapshot persistence reuses the cached auth state instead of calling Drive on every progress event.
- popup-visible recording lifecycle is now explicit via phases (`idle`, `recording`, `recorded`, `uploading`, `interrupted`) so stale upload results do not override an active recording session.
- upload byte totals should exclude optional artifacts that were skipped after failure so aggregate progress reaches the true final total.
- when optional upload artifacts fail after partial transfer, the denominator now drops only by the remaining unsent payload bytes so aggregate progress stays monotonic.
- player loading now ignores unknown-size responses until their final blob size is known, preventing the progress bar from briefly reaching 100% and then dropping once video totals are introduced.
- upload hard-fails when folder creation, metadata, manifest, recording index, or any video part upload fails; console/network/websocket uploads are best-effort and omitted from the manifest/index when they fail.
- player loading must surface transferred bytes and percent while downloading artifacts, and video part downloads should run in parallel rather than sequentially.
- player layout preferences are stored per-origin in `localStorage` under a single player UI state entry and restored on load.
- pane resize is clamped to keep both panes visible; the same persisted percent is reused when switching between horizontal and vertical layout modes.
- video "fullscreen" is implemented as an in-tab immersive player mode that hides the header and logs pane instead of using browser/OS fullscreen APIs.
- network detail derives response presentation from mime type plus URL extension, then renders either highlighted source, an inline preview, or both.
- HTML preview uses a sandboxed iframe, media preview uses inline data URLs when captured payloads are base64-backed, and JSON preview combines a summary card with formatted source.
- player title derives a short label from metadata URL plus recording timestamp and applies it to both the visible header and `document.title`.
- opening the player with no query params should render onboarding/help content rather than the invalid-params error; malformed partial query strings still use the error state.
- popup should provide direct links to the GitHub repository and a contribution surface so users can discover the project and help improve it, while auth status is revalidated on popup open instead of relying only on cached session state.
- per-file progress labels should use artifact-level filenames or stable labels so parallel transfers remain debuggable without coupling copy to transient upload ordering.
- popup should let the user configure an optional Google Drive parent folder by entering `/folder/path`, pasting a folder id, or pasting a Google Drive folder link; blank means Drive root.
- popup should expose recent upload history, and the same history should also sync into `gn-tracing-upload-history.json` inside the configured upload folder.
- stopping a finished capture should auto-start the Drive upload when a valid Drive token is already available.
- recording duration should exclude paused intervals, and popup controls should expose pause/resume separately from stop.

## 5. Constraints & Assumptions

- uploads require publicly shareable Drive permissions for replay links to work outside the extension.
- standalone mode depends only on direct public file download behavior for the artifact IDs embedded in the replay URL.
- standalone mode assumes the Cloudflare Pages deployment includes the `/api/drive` proxy function so the browser never fetches Drive artifacts cross-origin.
- extension build and standalone player build are separate pipelines.
- built-in player HTML and standalone wrapper HTML must stay markup-compatible because only `player.css` and `player.js` are synced automatically into `player-standalone/public/`; loading-state markup changes still require manual updates in `player-standalone/index.html`.
- response preview intentionally stays dependency-free and lightweight; syntax highlighting is implemented in local player runtime helpers rather than external libraries.
- manual Cloudflare Pages deployment expects project `gn-tracing-player`, root base path `/`, and secrets `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`.
- local deploys can source root `.env` / `.env.example` with `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_PAGES_PROJECT`, `PLAYER_HOST_URL`, and `VITE_BASE_PATH`.
- intro/empty-state copy should stay aligned between extension and standalone player shells so the hosted root URL behaves as a clear product landing page.
- service-worker restart recovery is intentionally best-effort: heavy artifacts still live in memory/offscreen only, but popup state is reconstructed from session snapshot plus offscreen probe when the capture document is still alive.
- Manual extension installation depends on users extracting the release zip and loading the built `dist/` folder through Chrome or Edge developer mode.

## 6. Relationships

- consumes recording artifacts from `recording-runtime`
- shares replay payload schema with built-in player and standalone player
- depends on `shared/api-conventions` for Chrome identity + Drive API assumptions
- exposes fixed player-host information to popup UX and release automation
- shares release packaging metadata with `manifest.template.json`, `.github/workflows/release.yml`, and root `package.json` scripts

## 7. Related Decisions

- auth is moved out of the popup into `drive-auth.html` to avoid popup closure interrupting OAuth.
- standalone replay distribution is standardized on Cloudflare Pages instead of popup-configured hosts.
- tag release automation delegates production extension build and zip packaging to root `package.json` scripts; standalone Cloudflare deploy is intentionally excluded from release CI.
- popup/auth surfaces consume a reduced runtime snapshot, while service worker/offscreen remain the capture engines; auth refresh is decoupled from snapshot persistence to avoid progress-time API chatter.
- upload progress snapshots now flow from offscreen to popup as an aggregate-plus-items contract, while player loading keeps a local per-entry registry that renders both the overall bar and each artifact row.
- replay links resolve through a single uploaded recording index file ID (`/<id>`), and the player fetches that index before loading metadata/log/video artifacts.
- player artifact downloads now use a one-day client-side cache, and the standalone Drive proxy also advertises one-day cacheability.
