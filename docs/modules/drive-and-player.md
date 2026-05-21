---
title: "Drive And Player"
description: "Current authentication, Google Drive upload, replay URL, and player architecture."
type: module
status: active
tags: ["drive", "player", "upload", "replay"]
source_paths:
  - "src/background/google-drive-auth.ts"
  - "src/drive-auth/drive-auth.ts"
  - "src/offscreen/offscreen.ts"
  - "src/shared/player-host.ts"
  - "Taskfile.yml"
  - "DEVELOPER.md"
  - "player"
  - "player-standalone"
related:
  - "./recording-runtime.md"
  - "../features/release-and-update-checks.md"
  - "../shared/data-models.md"
  - "../shared/api-conventions.md"
---

# Drive And Player

## Meta

- Trạng thái: active
- Phạm vi: Google Drive auth, zip package upload, replay URL generation, release packaging, and built-in/standalone player integration
- Nguồn code: `src/background/google-drive-auth.ts`, `src/drive-auth/drive-auth.ts`, `src/offscreen/offscreen.ts`, `src/shared/player-host.ts`, `player/`, `player-standalone/`
- Tuân thủ: Không áp dụng
- Links: [Recording Runtime](./recording-runtime.md), [Release And Update Checks](../features/release-and-update-checks.md), [Shared Data Models](../shared/data-models.md), [API Conventions](../shared/api-conventions.md)

## 1. Overview

This module covers authentication, Google Drive upload, replay URL generation, built-in player assets, and the optional standalone player:
- `src/background/google-drive-auth.ts`
- `src/drive-auth/drive-auth.ts`
- `esbuild.config.mjs`
- `manifest.template.json`
- `Taskfile.yml`
- `DEVELOPER.md`
- `player/*`
- `player-standalone/*`
- fixed replay host wiring in `src/offscreen/offscreen.ts`, `src/shared/player-host.ts`, and popup display in `src/popup/popup.ts`
- popup release discovery in `src/background/service-worker.ts` and `src/popup/popup.ts`

## 2. Functional & Non-Functional Requirements

- Allow the user to connect/disconnect Google Drive without relying on a backend.
- Keep Google OAuth client id and Chrome extension identity configurable through local `.env` values for development and GitHub repository secrets for production release builds.
- Upload each recording as one shareable zip package directly into the configured Google Drive upload folder and return a replay URL keyed by that zip file ID.
- Allow users to configure an optional zip password for new uploads; protected replay packages require the password in the player before artifacts are loaded.
- Split recorded video into `<= 32 MB` parts before upload when needed.
- Upload Google Drive artifacts with bounded parallelism instead of strictly serial transfer.
- Throttle high-frequency upload progress updates so popup state sync stays responsive while preserving immediate per-file state transitions.
- Always return the Cloudflare-hosted standalone player URL at `https://tracing.gnas.dev/`.
- Let the extension-hosted player use the user's existing Drive OAuth token to download replay packages through the Drive API media endpoint before falling back to public download paths.
- Keep auth UI resilient to popup lifetime by using a dedicated auth page.
- Keep standalone player deployable to Cloudflare Pages through a separate manual path outside the GitHub release workflow.
- Keep GitHub Releases focused on the manual unpacked install zip.
- Keep replay player layout user-adjustable with a draggable splitter, persisted split percentage, and switchable horizontal/vertical pane orientation.
- Allow the video pane to expand to an immersive tab-level mode inside the player surface without triggering OS/screen fullscreen.
- Keep network response inspection readable with syntax-highlighted source views for JavaScript, HTML, CSS, and JSON payloads.
- Show source-mapped console locations with a bounded source preview when the recording artifact includes sourcemap `sourcesContent` snippets.
- Provide inline response preview panels for HTML, media, and JSON artifacts inside the network detail inspector.
- Include recording-specific metadata in the player title so multiple open replay tabs remain distinguishable.
- Show a usage/intro landing state when the player opens without replay query params, including GitHub and contribution guidance.
- Surface GitHub and contribution entry points inside the extension popup, without exposing the fixed player host as popup UI.
- Let the popup compare the installed version with the latest GitHub release and surface a release/download path when a newer extension zip exists.
- Keep extension runtime state mirrored into a popup/auth snapshot without forcing a live Google Drive verification on every state write.
- Recover popup-visible recording state after service-worker restart by reconciling the last session snapshot with the offscreen capture state when possible.

## 3. Data Models & APIs

- `GoogleDriveAuth.getAuthToken()` returns a usable token or `null`.
- extension builds inject `GOOGLE_CLIENT_ID` into `GoogleDriveAuth` and `dist/manifest.json` from `.env`, environment variables, or release workflow secrets; production builds require explicit OAuth and extension identity values.
- `manifest.template.json` is the manifest source of truth; build-time substitution writes the OAuth client id and Chrome extension public key into `dist/manifest.json`.
- unprotected uploads package `metadata.json`, `manifest.json`, `recording-index.json`, optional log JSON files, and one or more `video.part-XXX.webm` files into a single `gn-tracing-*.zip` stored directly inside the configured upload folder.
- password-protected uploads encrypt that normal recording zip with Web Crypto (`PBKDF2-SHA-256` plus `AES-GCM`) and upload an outer zip containing only clear unlock metadata plus `encrypted-payload.bin`.
- `manifest.json` inside the zip is the storage layout source of truth; it records schema version, target folder ID, video mime type/parts, and which optional artifacts exist.
- `recording-index.json` inside an unprotected zip is the replay entrypoint metadata; protected outer zips use clear `recording-index.json` only to describe encryption metadata and payload path.
- replay links use a single zip file ID path, for example `https://tracing.gnas.dev/<zip-file-id>`.
- the player also retains a legacy direct-file query parser for debugging or older links that still pass `videos`, `metadata`, `console`, `network`, and `websocket` params.
- standalone player loads the index first, then loads artifacts directly from the file IDs listed by that index and does not require Drive folder listing or a Drive API key for replay.
- player video part downloads use bounded concurrency and skip Cache API storage for large video blobs to avoid first-load memory duplication.
- extension-hosted player download can use Google Drive API `files.get?alt=media&supportsAllDrives=true` with the in-memory OAuth token returned by `GET_GOOGLE_DRIVE_TOKEN`.
- standalone player proxies artifact downloads through a same-origin Cloudflare Pages Function at `/api/drive` to avoid browser CORS/CORP failures against public Google Drive download hosts, resolve Drive confirmation pages for large public files when OAuth is unavailable, and prevent unresolved HTML confirmation responses from being cached as replay artifacts.
- popup update checks use the GitHub Releases API to compare the installed package version with the latest release and discover the versioned extension zip asset.

## 4. Business Rules

- Chrome uses `chrome.identity.getAuthToken`; Edge uses `launchWebAuthFlow` and stores a verified access token locally.
- Chrome OAuth identity is configured by `GOOGLE_CLIENT_ID`, `CHROME_EXTENSION_ID`, and `CHROME_EXTENSION_PUBLIC_KEY`; the build validates that the configured extension id matches the public key before writing `dist/manifest.json`.
- disconnect always attempts revocation but returns a success-style response even when the token is already invalid.
- the uploaded recording zip is made world-readable before being referenced by the player; failed share-permission creation fails the upload instead of returning a broken replay link.
- if a zip password is configured, the Drive file remains readable by link but replay artifacts stay encrypted until the player derives the key from the password entered by the viewer.
- service-worker settings snapshots expose only whether a zip password is configured; the plaintext password is kept out of popup state, upload history, replay URLs, and recording package metadata.
- replay links always target the full Cloudflare Pages player host URL directly.
- the auth page is a first-class surface that can both start auth and react to service-worker state updates.
- standalone player is not the system of record for assets; it mirrors `player/` runtime logic through the sync script and wrapper adapters.
- player download first uses authenticated Drive API media fetches when an extension OAuth token is available, but never places the token in replay URLs, uploaded artifacts, Cache API keys, or Cloudflare proxy requests.
- player download falls back to the public/proxy Drive path when no token is available or the authenticated request returns an auth/access failure that may still succeed for link-readable files.
- release automation expects both npm workspaces to have committed lockfiles and delegates build, zip, Store validation, and deploy commands to `Taskfile.yml`.
- tag-based GitHub releases build the extension with repository secrets `GOOGLE_CLIENT_ID`, `CHROME_EXTENSION_ID`, `CHROME_EXTENSION_PUBLIC_KEY`, and `CHROME_EXTENSION_PRIVATE_KEY`, then publish `gn-tracing-extension-${tag}.zip` containing `gn-tracing-extension-${tag}/` for manual unpacked installation; they do not publish CRX/update XML artifacts or invoke Cloudflare deploy steps for the standalone player.
- if video exceeds the upload limit, offscreen upload slices the final recording blob into ordered byte chunks and the player reassembles them locally before playback.
- popup upload status must surface both aggregate transferred bytes/percent and per-file progress rows throughout the Drive upload flow.
- player loading must surface both aggregate transferred bytes/percent and per-file progress rows for the recording index, metadata, optional artifacts, manifest, and each video part.
- upload progress measures artifact payload bytes rather than raw multipart HTTP body bytes so aggregate totals match the recording artifacts shown to the user.
- upload progress updates are throttled between transfer events, while queued/uploading/uploaded/skipped/failed state changes are emitted immediately.
- upload file transfers run with bounded concurrency, and Drive sharing permission creation no longer occupies the file upload worker slot.
- service worker must re-hydrate Google Drive auth status on startup/install so popup state stays correct after extension reloads.
- service worker treats Google Drive connectivity as a separately refreshed cache; snapshot persistence reuses the cached auth state instead of calling Drive on every progress event.
- popup-visible recording lifecycle is explicit via phases (`idle`, `recording`, `recorded`, `uploading`, `interrupted`) so stale upload results do not override an active recording session.
- upload byte totals should exclude optional artifacts that were skipped after failure so aggregate progress reaches the true final total.
- when optional upload artifacts fail after partial transfer, the denominator drops only by the remaining unsent payload bytes so aggregate progress stays monotonic.
- player loading ignores unknown-size responses until their final blob size is known, preventing the progress bar from briefly reaching 100% and then dropping once video totals are introduced.
- upload hard-fails when target-folder resolution, zip packaging, zip upload, or share-permission creation fails.
- player loading must surface transferred bytes and percent while downloading artifacts, and video part downloads run with bounded parallelism rather than unbounded `Promise.all`.
- player layout preferences are stored per-origin in `localStorage` under a single player UI state entry and restored on load.
- pane resize is clamped to keep both panes visible; the same persisted percent is reused when switching between horizontal and vertical layout modes.
- video "fullscreen" is implemented as an in-tab immersive player mode that hides the header and logs pane instead of using browser/OS fullscreen APIs.
- network detail derives response presentation from mime type plus URL extension, then renders either highlighted source, an inline preview, or both.
- console detail renders source-mapped file/line metadata and, when present, a small highlighted source preview from the captured console artifact without fetching source files during replay.
- HTML preview uses a sandboxed iframe, media preview uses inline data URLs when captured payloads are base64-backed, and JSON preview combines a summary card with formatted source.
- player title derives a short label from metadata URL plus recording timestamp and applies it to both the visible header and `document.title`.
- player unlocks password-protected packages by prompting for the recording password, decrypting the inner zip in-browser, and then using the same parser path as unprotected packages.
- opening the player with no query params should render onboarding/help content rather than the invalid-params error; malformed partial query strings still use the error state.
- popup should provide direct links to the GitHub repository and a contribution surface so users can discover the project and help improve it, while auth status is revalidated on popup open instead of relying only on cached session state.
- popup should run a lightweight update check on open, provide a manual check action, and only guide the user to a release/download page; it does not self-install extension updates.
- per-file progress labels should use artifact-level filenames or stable labels so parallel transfers remain debuggable without coupling copy to transient upload ordering.
- popup should default uploads to `/gn-tracing` and let the user configure a Google Drive parent folder by entering `/folder/path`, pasting a folder id, or pasting a Google Drive folder link; blank or `/` means Drive root.
- popup should expose recent upload history from local extension storage only; upload history is not written to Google Drive.
- stopping a finished capture should auto-start the Drive upload when a valid Drive token is already available.
- popup recording controls expose start, stop, and remove actions; stop and remove are grouped together while a recording is active.

## 5. Constraints & Assumptions

- uploads require publicly shareable Drive permissions for replay links to work outside the extension.
- password-protected uploads protect package contents rather than Drive file discoverability; users still control who receives the replay URL and password.
- password-protected uploads are GN Tracing encrypted packages, not native ZIP password files compatible with desktop unzip password prompts.
- forgotten zip passwords cannot be recovered by GN Tracing because the encrypted payload is decrypted only from the user-provided password.
- standalone mode depends on the `/api/drive` public proxy for the artifact IDs embedded in the replay URL unless a future hosted web OAuth flow explicitly supplies a token.
- standalone mode assumes the Cloudflare Pages deployment includes the `/api/drive` proxy function so the browser never fetches Drive artifacts cross-origin.
- extension build and standalone player build are separate pipelines.
- local development extension builds may fall back to development OAuth/extension identity defaults, but production extension builds require explicit `GOOGLE_CLIENT_ID`, `CHROME_EXTENSION_ID`, and `CHROME_EXTENSION_PUBLIC_KEY`.
- built-in player HTML and standalone wrapper HTML must stay markup-compatible because only `player.css` and `player.js` are synced automatically into `player-standalone/public/`; loading-state markup changes still require manual updates in `player-standalone/index.html`.
- response preview intentionally stays dependency-free and lightweight; syntax highlighting is implemented in local player runtime helpers rather than external libraries.
- console source previews are dependency-free and artifact-backed; replay does not fetch original sourcemaps or application source files from the recorded page.
- manual Cloudflare Pages deployment expects project `gn-tracing-player`, root base path `/`, and secrets `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`.
- local deploys can source root `.env` / `.env.example` with `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_PAGES_PROJECT`, `PLAYER_HOST_URL`, and `VITE_BASE_PATH`.
- intro/empty-state copy should stay aligned between extension and standalone player shells so the hosted root URL behaves as a clear product landing page.
- service-worker restart recovery is intentionally best-effort: heavy artifacts still live in memory/offscreen only, but popup state is reconstructed from session snapshot plus offscreen probe when the capture document is still alive.
- Manual extension installation depends on users extracting the release zip and loading the built `gn-tracing-extension-v<version>/` folder through Chrome or Edge developer mode.

## 6. Relationships

- consumes recording artifacts from `recording-runtime`
- shares replay payload schema with built-in player and standalone player
- depends on `shared/api-conventions` for Chrome identity + Drive API assumptions
- exposes fixed player-host information to popup UX and release automation
- shares release packaging metadata with `manifest.template.json`, `Taskfile.yml`, `DEVELOPER.md`, and root `package.json` scripts

## 7. Related Decisions

- auth is moved out of the popup into `drive-auth.html` to avoid popup closure interrupting OAuth.
- standalone replay distribution is standardized on Cloudflare Pages instead of popup-configured hosts.
- tag release automation delegates production extension build and zip packaging to root `package.json` scripts; standalone Cloudflare deploy is intentionally excluded from release CI.
- popup/auth surfaces consume a reduced runtime snapshot, while service worker/offscreen remain the capture engines; auth refresh is decoupled from snapshot persistence to avoid progress-time API chatter.
- upload progress snapshots flow from offscreen to popup as an aggregate-plus-items contract, while player loading keeps a local per-entry registry that renders both the overall bar and each artifact row.
- replay links resolve through a single uploaded zip file ID (`/<id>`), and the player unpacks that zip before loading metadata/log/video artifacts.
- player artifact downloads use a one-day client-side cache, and the standalone Drive proxy also advertises one-day cacheability.
