---
title: "Build From Scratch Index"
description: "Navigation and dependency map for the build-from-scratch guide."
type: index
status: active
tags: ["build", "index", "nav"]
related:
  - "./README.md"
  - "./_sync.md"
  - "./01-prerequisites.md"
---

# Build From Scratch Index

## Chapters

- [README.md](./README.md)
- [01-prerequisites.md](./01-prerequisites.md)
- [02-scaffolding.md](./02-scaffolding.md)
- [03-extension-root-manifest.md](./03-extension-root-manifest.md)
- [04-extension-build-esbuild.md](./04-extension-build-esbuild.md)
- [05-extension-static-assets.md](./05-extension-static-assets.md)
- [06-extension-source-layers.md](./06-extension-source-layers.md)
- [07-standalone-player.md](./07-standalone-player.md)
- [08-oauth-worker.md](./08-oauth-worker.md)
- [09-taskfile-commands.md](./09-taskfile-commands.md)
- [10-environment-and-secrets.md](./10-environment-and-secrets.md)
- [11-testing-three-contexts.md](./11-testing-three-contexts.md)
- [12-load-locally.md](./12-load-locally.md)
- [13-release-flow.md](./13-release-flow.md)
- [14-store-package-validation.md](./14-store-package-validation.md)
- [15-quality-gates.md](./15-quality-gates.md)
- [16-testing-strategy.md](./16-testing-strategy.md)
- [_sync.md](./_sync.md)

## Reader Path

1. [01-prerequisites.md](./01-prerequisites.md)
2. [02-scaffolding.md](./02-scaffolding.md)
3. [03-extension-root-manifest.md](./03-extension-root-manifest.md)
4. [04-extension-build-esbuild.md](./04-extension-build-esbuild.md)
5. [05-extension-static-assets.md](./05-extension-static-assets.md)
6. [06-extension-source-layers.md](./06-extension-source-layers.md)
7. [07-standalone-player.md](./07-standalone-player.md)
8. [08-oauth-worker.md](./08-oauth-worker.md)
9. [09-taskfile-commands.md](./09-taskfile-commands.md)
10. [10-environment-and-secrets.md](./10-environment-and-secrets.md)
11. [11-testing-three-contexts.md](./11-testing-three-contexts.md)
12. [12-load-locally.md](./12-load-locally.md)
13. [13-release-flow.md](./13-release-flow.md)
14. [14-store-package-validation.md](./14-store-package-validation.md)
15. [15-quality-gates.md](./15-quality-gates.md)

## Dependency Map

- `04-extension-build-esbuild` requires `01-prerequisites`, `02-scaffolding`, `03-extension-root-manifest`.
- `05-extension-static-assets` requires `01-prerequisites` (icons, theme files).
- `06-extension-source-layers` requires `04-extension-build-esbuild` (entry points must exist).
- `07-standalone-player` requires `01-prerequisites`, `05-extension-static-assets` (player assets are shared).
- `08-oauth-worker` requires `01-prerequisites`, `10-environment-and-secrets` (secrets).
- `09-taskfile-commands` requires all of `02`..`08` to be runnable.
- `11-testing` requires `02-scaffolding` (vitest.shared.ts) and the source layers from each context.
- `12-load-locally` requires `04` + `05` + `10` (`GOOGLE_CLIENT_ID`).
- `13-release-flow` requires `12` (local build works) + `10` (all secrets in repo).
- `14-store-validation` requires `13` (production build artifact).
- `15-quality-gates` requires `02` + `04` (Biome, Husky, knip wired into `package.json`).

## Tracked Files Outside This Folder

Each chapter cross-references the actual implementation files. The most central ones:

- [`../../esbuild.config.mjs`](../../esbuild.config.mjs) — root extension build (chapter 04)
- [`../../manifest.template.json`](../../manifest.template.json) — placeholder manifest (chapter 03)
- [`../../Taskfile.yml`](../../Taskfile.yml) — task alias catalog (chapter 09)
- [`../../package.json`](../../package.json) — root scripts + dev deps (chapter 02)
- [`../../.env.example`](../../.env.example) — variable catalog (chapter 10)
- [`../../vitest.shared.ts`](../../vitest.shared.ts) — shared test base (chapter 11)
- [`../../player-standalone/vite.config.ts`](../../player-standalone/vite.config.ts) — Vite player (chapter 07)
- [`../../worker/wrangler.toml`](../../worker/wrangler.toml) — Worker config (chapter 08)
- [`../../scripts/check-store-package.mjs`](../../scripts/check-store-package.mjs) — Store package rules (chapter 14)
