---
title: "09 - Taskfile Commands"
description: "Every Taskfile.yml alias and what it does, end to end."
type: build
status: active
tags: ["build", "task", "cli"]
related:
  - "./04-extension-build-esbuild.md"
  - "./07-standalone-player.md"
  - "./08-oauth-worker.md"
---

# 09 - Taskfile Commands

## Meta

- Goal: catalog every alias in `Taskfile.yml` so you can map an intent to a single command.
- Verification: running `task --list` from the repo root matches the table below.

## 9.1 Root Extension Aliases

| Alias | Command | When to use |
| --- | --- | --- |
| `task build` | `node esbuild.config.mjs --env development` | Development build into `dist/` |
| `task dist` | `node esbuild.config.mjs --env production` | Production build into `dist/` |
| `task watch` | `node esbuild.config.mjs --watch` | Continuous rebuild while iterating |
| `task typecheck` | `npx tsc --noEmit` | Type-check the root sources |
| `task lint` | `npm run lint` | Biome lint only |
| `task format` | `npm run format` | Biome format + write |
| `task format:check` | `npm run format:check` | Biome format check + `docs:check` |
| `task check` | `npm run check` | Biome lint + format + `docs:check` |
| `task test` | `npm run test` | Run the root context tests once |
| `task test:all` | loops through root, player, worker tests | Pre-release sanity |

The `task test:all` definition:

```yaml
test:all:
  cmds:
    - cmd: |
        failed=""
        npm run test || failed="$failed root"
        (cd player && npm run test) || failed="$failed player"
        (cd worker && npm run test) || failed="$failed worker"
        ...
```

It runs every context, accumulates failures, and exits 1 if any context failed.

## 9.2 Standalone Player Aliases

| Alias | What it does |
| --- | --- |
| `task player:sync` | `node player/scripts/sync-player.js` |
| `task player:dev` | `vite --port 5176` inside `player/` |
| `task player:build` | sync + `tsc` + `vite build --mode development` |
| `task player:dist` | sync + `tsc` + `vite build --mode production` |
| `task player:build:cloudflare` | `player:dist` with `VITE_BASE_PATH` override |
| `task player:preview` | `vite preview` |
| `task player:typecheck` | `tsc --noEmit` |
| `task player:deploy` | `./deploy.sh` inside `player/` |

`player:build` and `player:dist` declare `deps: [player:sync]` so the asset mirror runs first unconditionally.

## 9.3 Worker Aliases

| Alias | What it does |
| --- | --- |
| `task worker:dev` | `wrangler dev` inside `worker/` |
| `task worker:typecheck` | `tsc --noEmit` |
| `task worker:deploy` | `./deploy.sh` inside `worker/` |

## 9.4 Combined Aliases

| Alias | What it runs |
| --- | --- |
| `task build:all` | Chrome + Edge + Opera + Firefox development packages |
| `task dist:all` | Chrome + Edge + Opera + Firefox production packages |
| `task dev` | Full stack for one browser (default Chrome): watch + player + Worker |
| `task dev:chrome` / `dev:edge` / `dev:opera` / `dev:firefox` | Same stack for that browser |
| `task dev BROWSER=all` / `task dev:all` | All four extension watchers + reload + Player + Worker (7 processes) |

`task dev` is the local development workhorse: it starts the development reload coordinator, Chrome and Firefox extension watchers by default, the player (`:5176`), and the Worker (`:63972`). Set `BROWSER=chrome|edge|opera|firefox` for one target, `BROWSER=both` for the default Chrome + Firefox pair, or `BROWSER=all` / `task dev:all` for every target. `task watch` accepts one browser only; `task dev` also accepts `both` and `all`. CLI var and env `BROWSER` both work.

Because the player and Worker are per-repo rather than per-target, `player:dev` and `worker:dev` probe their port with `scripts/port-listening.mjs` and reuse a running instance instead of failing to bind. Two `task dev` stacks for different browsers can therefore run side by side.

## 9.5 Release Aliases

| Alias | What it does |
| --- | --- |
| `task release:zip` | Wraps `dist/` into `gn-tracing-extension-${tag}.zip` |
| `task release:ci` | `task dist` + `task release:zip` |
| `task store:check` | typecheck both contexts + `npm audit --omit=dev` + production build + `scripts/check-store-package.mjs` |
| `task store:zip` | `task store:check` then zip `dist/` into `gn-tracing-store.zip` |
| `task store:status` | `scripts/chrome-webstore.mjs status` |
| `task store:upload` | `scripts/chrome-webstore.mjs upload --zip gn-tracing-store.zip` |
| `task store:publish` | `scripts/chrome-webstore.mjs publish` |
| `task store:release` | `store:zip` + `store:upload` + `store:publish` |

`release:zip` shells out to `zip` (from `apt install zip` / `brew install zip`) and uses the GitHub ref name when present:

```bash
release_name="gn-tracing-extension-${GITHUB_REF_NAME:-local}"
trap 'rm -rf "$release_name"' EXIT
rm -rf "$release_name" "$release_name.zip"
cp -R dist "$release_name"
zip -r "$release_name.zip" "$release_name"
```

## 9.6 Which Command When?

| Intent | Command |
| --- | --- |
| Try the extension locally | `task build` then chapter `12` |
| Iterate on extension sources | `task watch` |
| Iterate on extension + player + Worker | `task dev` |
| Production extension build | `task dist` |
| Production bundle of both extension and player | `task dist:all` |
| Cut a release tag | `task release:ci` (locally) or push a `v*` tag and let `.github/workflows/release.yml` run it (chapter `13`) |
| Ship to Chrome Web Store | `task store:release` |

## 9.7 Notes

- `task` itself is `go-task`. On macOS: `brew install go-task`. On Windows: `choco install go-task`. On Linux: `snap install task --classic`.
- Anything wrapped in `npm run` is also available without `task`: `npm run build`, `npm run dist`, `npm run watch`, `npm run test`, `npm run check`.
- The `task dev` concurrency uses `npx concurrently`, which is already in `devDependencies`.

## You Should Now Have

- `task --list` output that matches the tables above.
- A mental mapping from intent to command.

Move on to [10 - Environment & Secrets](./10-environment-and-secrets.md).
