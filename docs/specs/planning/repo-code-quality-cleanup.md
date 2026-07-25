# Repo Code Quality Review & Cleanup Plan

**Date:** 2026-07-25
**Scope:** Full-repo maintainability audit (not a single PR).
**Status:** **Phase 0 + Phase 1 done** (gitignore, knip entries, confirmed dead helpers/exports, empty `.vscode` removed, hygiene regression tests). **Phases 2–5 are deferred** — large structural refactors only; do not start them as partial edits in production paths.

## Executive Verdict

**Not approve as “healthy architecture” without further decomposition.**
Behavior is largely coherent (MV3 recording + multi-cloud upload + player), and several extractions already landed (`settings-store`, `message-router`, `upload-orchestrator`, `storage/*`, auth strategy in Drive). But the codebase still has **five god surfaces** that concentrate orchestration, UI, CDP, and replay. That is the main structural risk — not missing features.

| Surface | Lines (approx.) | Role today | Structural problem |
| --- | ---: | --- | --- |
| `player/player.js` (+ synced copy) | **7.6k × 2** | Extension + standalone replay | Untyped monolith; **duplicated blob** in git |
| `src/background/cdp-manager.ts` | **2.5k** | CDP attach, network, console, DOM, sourcemaps | Domain spaghetti in one class |
| `src/background/service-worker.ts` | **2.4k** | Composition root + lifecycle + capture orchestration | Still owns too much after partial split |
| `src/popup/popup.ts` | **2.1k** | Popup UI + storage UX + sessions + feedback | View + orchestration + i18n + icons |
| `src/settings/settings.ts` | **1.6k** | Capture/privacy settings surface | Same UI-monolith pattern as popup |
| `src/offscreen/offscreen.ts` | **1.1k** | MediaRecorder + zip + multi-cloud upload | Crosses media + packaging + provider I/O |

Approval bar for “maintainable” fails on: file-size explosion, special-case branching across storage aliases, and a second full copy of `player.js`.

---

## Priority Findings (strict order)

### 1. Structural — `player/player.js` is the system bottleneck

- **7.6k lines of untyped browser JS**, copied 1:1 into `player-standalone/public/player.js` (same hash) and into `dist/`.
- Two tracked copies of the same ~278KB file is accidental product architecture, not intentional modularity.
- Dropbox authenticated download logic is **reimplemented inline** in the player instead of sharing a single helper (TS helper `getDropboxAuthenticatedDownloadHeaders` was dead and removed in Phase 0).

**Code-judo move:** make `player/` the single source of truth; standalone **must only sync at build** (already partially true via `sync-player.js`) and **stop committing** the generated `public/player.js` (or commit a thin loader). Longer term: split player into modules (load package, timeline, network panel, storage download adapters) and type the boundaries even if still esbuild’d to IIFE.

### 2. Missed simplification — service worker split is half-done

Already extracted: `settings-store`, `capture-environment`, `upload-orchestrator`, `message-router`, `storage/*`.

Still living in `service-worker.ts` (~70 functions):

- Active recording state machine (`start`/`stop`/`remove`)
- In-page capture inject + redaction path (parallel to CDP redaction)
- Drawing overlay lifecycle
- Session/artifact persistence and popup state mirror
- Storage connect/status/upload entrypoints

**Code-judo move:** finish the plan in `chromium-auth-and-codebase-cleanup.md` — move recording lifecycle into `recording-session.ts` (or grow `RecorderManager`), drawing into `drawing-controller.ts`, in-page path into `in-page-capture-coordinator.ts`. Leave SW as **composition root only** (wire + `registerMessageListeners`).

### 3. Spaghetti / branching — multi-cloud alias tax

Message router still carries dual actions forever:

```text
STORAGE_*  ⟷  GOOGLE_DRIVE_*
UPLOAD_TO_GOOGLE_DRIVE (legacy name, multi-backend data)
```

Popup still shims `googleDrive.isConnected` beside `storage.provider`. Offscreen still switches on `UPLOAD_TO_GOOGLE_DRIVE` for generic upload.

**Code-judo move:** one canonical message vocabulary (`STORAGE_*` only). Keep thin adapters for one release if bookmarks require it, then delete aliases. Collapse popup state to a single `storage: { provider, isConnected }` model without Drive-named mirrors in API surface.

### 4. Boundary / types — loose `Record<string, unknown>` message data

Nearly every handler takes `data?: Record<string, unknown>` and re-parses. That hides invariants and forces ad-hoc guards in SW, popup, settings, offscreen.

**Prefer:** discriminated `ServiceWorkerMessage` payloads per action (or zod/valibot at the boundary once). `message-router` offscreen progress listener was `any` — tightened in Phase 0 to a narrow shape.

### 5. File size — `cdp-manager.ts` (2.5k) is past healthy class size

One class owns attach/detach, network, websocket, console, cookies, storage snapshots, DOM snapshot + mask, sourcemap resolve.

**Prefer extract:** `cdp/network-collector.ts`, `cdp/console-collector.ts`, `cdp/dom-snapshot.ts`, `cdp/sourcemap-session.ts` behind a thin `CdpManager` facade. Do not grow this file further.

### 6. Modularity — dual packages without workspace discipline

Root + `player-standalone/` + `worker/` are three Node projects with separate `node_modules`. Fine operationally, but:

- Knip only sees root `src/`
- Player vendor assets are triplicated (`player/vendor`, `dist/player/vendor`, `player-standalone/public/vendor`)
- No monorepo tooling; shared types stop at the extension boundary

### 7. Tooling debt (partially fixed in Phase 0)

| Issue | Status |
| --- | --- |
| Knip missing content/storage-auth entries → false “unused files” | **Fixed** |
| `.gitignore` thin vs nested wrangler/tmp/dev.vars/editor noise | **Hardened** |
| Dead `@deprecated` Drive mirrors in SW/popup | **Removed** |
| Barrel `storage/index.ts` re-exported unused surface | **Slimmed** |
| Dead `getDropboxAuthenticatedDownloadHeaders` | **Removed** (player still has inline copy — follow-up) |
| Biome: 100+ CSS specificity / `!important` warnings | Open (low urgency) |
| Empty tracked `.vscode/settings.json` | **Removed**; `.vscode/` gitignored |

---

## What is already good (do not regress)

- **Storage provider registry** (`src/background/storage/*`) is the right abstraction for multi-cloud.
- **Drive auth strategy pattern** (Chrome identity vs web-auth-flow) is the correct Chromium model.
- **Privacy redaction** as a pure shared module with property tests is strong.
- **Worker** as OAuth/feedback proxy keeps secrets out of the extension.
- **esbuild define** for env-specific proxy URLs is clear.
- Move-only extractions already done show the team can split SW safely.

---

## Phase plan

### Phase 0 — **DONE** (safe, behavior-preserving)

1. Harden root `.gitignore`.
2. Fix `knip.json` entry points + Taskfile color binary noise.
3. Delete unused deprecated Drive UI/state helpers.
4. Slim storage barrel; drop unused feedback re-exports; remove dead Dropbox header helper.
5. Type the offscreen progress listener (no `any`).

### Phase 1 — **DONE** (dead surface cleanup / residual hygiene)

- Knip clean for configured extension entry points (no unused files/exports; config hints OK).
- Empty `.vscode/settings.json` removed; `.vscode/` ignored.
- Hygiene regression tests in `test/cleanup-hygiene.test.ts` (entry wiring, dead helpers, barrel, gitignore).
- Knip is authoritative only for root extension TS (`src/**`, `scripts/**`); not player-standalone/worker monorepo-wide.

### Phase 2 — **DEFERRED** — finish service-worker decomposition (medium)

- Extract recording session lifecycle, drawing controller, in-page coordinator.
- Target: `service-worker.ts` &lt; ~400 lines composition root.
- No message contract changes.
- **Do not half-apply** this in production paths until scheduled as its own change.

### Phase 3 — **DEFERRED** — collapse storage aliases (medium, behavior-sensitive)

- Single message API; migrate popup/drive-auth/player token fetch.
- Remove `googleDrive` shim from `PopupState` after consumers update.
- Keep one-release alias only if store users need it.

### Phase 4 — **DEFERRED** — player modularization (large)

- Stop dual-tracking identical `player.js` (gitignore generated copy or generate both from one module graph).
- Split by domain; share Dropbox/Drive download adapters with typed contracts.
- Prefer gradual esbuild bundle over big-bang rewrite.

### Phase 5 — **DEFERRED** — cdp-manager + popup/settings split (large)

- CDP collectors by domain.
- Popup: render vs actions vs storage-status modules.
- Settings: profile model vs DOM wiring.

---

## Explicit non-goals (this review)

- Firefox/Safari support.
- Changing OAuth to auth-code + refresh (unless product requires it).
- Rewriting player in React/framework.
- Expanding cloud providers beyond Drive/Dropbox.

---

## Verification for any cleanup PR

```bash
npm test
npm run deadcode
npx biome check . --files-ignore-unknown=true
# or Taskfile equivalents:
task typecheck   # if defined
task build
task test
```

Manual: start/stop recording, upload Drive + Dropbox, open extension player + standalone player, storage connect/disconnect on Chrome and one non-Chrome Chromium.
