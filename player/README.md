# GN Tracing Player

## Production runtime

| Piece | Path |
| --- | --- |
| Hosted entry | `index.html` → Vite → `src/main.ts` |
| Bootstrap | `src/main.ts` sets `GN_TRACING_CONFIG`, injects `/player.js` |
| Player shell | `public/player.js` (vanilla, shared with static `public/player.html`) |
| Shared pure logic | `src/shared/*` → `core-entry.ts` → `public/vendor/gn-core/gn-core.iife.js` |
| Cloud proxies | `functions/api/drive.js`, `functions/api/dropbox.js` |

Rebuild core after shared changes:

```bash
npm run vendor:player-core   # from repo root
```

`window.gnCore` is a **hard boot dependency**. The player does not ship a second copy of presentation/seek policy for “gnCore missing” mode.

## Architecture direction

Production stays on the vanilla runtime while domain logic is owned by shared modules (`src/shared/*` → `gnCore`). The shell applies DOM only for pure domains.

| Domain | Source of truth |
| --- | --- |
| Presentation chrome | `src/shared/player-presentation.ts` |
| Storage start/stop diff | `src/shared/storage-diff.ts` |
| Clock / active index | `src/shared/player-clock-index.ts` |
| Loading progress math | `src/shared/player-loading-progress.ts` |
| EN/VI strings | `src/shared/player-i18n/` |
| ZIP central directory | `packages/replay-core/src/zip-reader.ts` |
| Seek / still math | existing shared modules |

New product pure logic belongs in `src/shared/` + `core-entry` export. Do **not** reimplement private copies inside `player.js`. Do **not** add product features to the Solid experimental tree.

## Solid experimental (archived)

`src/main.tsx`, `App.tsx`, `components/`, `panels/`, partial `package/load-package.ts` are **not production** and are not feature-parity. Do not extend them for product work. A full rewrite would be a cutover project, not dual-maintain.

## Local dev

```bash
cd player && npm run dev   # port 5176
```

## Tests

```bash
cd player && npm test
```
