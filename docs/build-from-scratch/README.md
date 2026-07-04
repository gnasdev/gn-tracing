---
title: "Build GN Tracing From Scratch"
description: "Entry point for the step-by-step guide to rebuilding the entire GN Tracing system from scratch."
type: build
status: active
tags: ["build", "guide", "index"]
related:
  - "./_index.md"
  - "./_sync.md"
  - "./01-prerequisites.md"
---

# Build GN Tracing From Scratch

This directory is a step-by-step guide for rebuilding the entire GN Tracing system from an empty repository:

- the Chromium Manifest V3 extension (root + `esbuild`)
- the hosted replay player (`player-standalone` + Vite + Cloudflare Pages)
- the OAuth token-exchange Worker (`worker/` + Wrangler + Cloudflare Workers)

Each chapter contains commands you can copy-paste, file references so you can verify against the existing checkout, and a short "What you should have now" checkpoint before moving on.

## How to read this guide

Read in order. Chapters build on each other; chapter `05` assumes chapter `04` already produced a working `dist/`, and chapter `08` assumes chapter `07` already runs locally.

If you only need the extension (no hosted player, no Worker), stop after chapter `06` and skip to chapter `12` to load it locally.

If you want release-grade packaging, also walk chapters `13` → `15` last.

## Chapter map

1. [Prerequisites](./01-prerequisites.md) — Node, Chromium, accounts, keypair.
2. [Scaffolding](./02-scaffolding.md) — root `package.json`, `tsconfig.json`, `biome.json`, `vitest.shared.ts`.
3. [Extension Manifest](./03-extension-root-manifest.md) — `manifest.template.json` placeholders, permissions, OAuth2 client.
4. [Extension Build](./04-extension-build-esbuild.md) — `esbuild.config.mjs`, three contexts, define constants, watch mode.
5. [Static Assets](./05-extension-static-assets.md) — copy HTML/CSS, icons, theme, player assets into `dist/`.
6. [Source Layers](./06-extension-source-layers.md) — the `src/`, `popup/`, `settings/`, `history/`, `offscreen/`, `drive-auth/`, `shared/` tree.
7. [Standalone Player](./07-standalone-player.md) — `player-standalone/` Vite app, `sync-player.js`, Drive proxy.
8. [OAuth Worker](./08-oauth-worker.md) — `worker/` Wrangler config, `ALLOWED_EXTENSION_ORIGINS`, secrets.
9. [Taskfile Commands](./09-taskfile-commands.md) — the entire `Taskfile.yml` alias catalog.
10. [Environment & Secrets](./10-environment-and-secrets.md) — every variable in `.env.example`.
11. [Testing](./11-testing-three-contexts.md) — three Vitest contexts (root node, player jsdom, worker workerd).
12. [Load Locally](./12-load-locally.md) — `dist/` into Chrome, manual smoke test of popup/recording/offscreen.
13. [Release Flow](./13-release-flow.md) — tag-driven, `.github/workflows/release.yml`, `store:zip`.
14. [Store Validation](./14-store-package-validation.md) — `scripts/check-store-package.mjs` rules.
15. [Quality Gates](./15-quality-gates.md) — Biome, Knip, Husky pre-commit, `docs:check`.

See [_index.md](./_index.md) for the reader path and dependency map, or [_sync.md](./_sync.md) for the current code/docs sync state of this guide.
