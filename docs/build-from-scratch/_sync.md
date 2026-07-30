---
title: "Build From Scratch Sync State"
description: "Current synchronization snapshot for the build-from-scratch guide."
type: sync
status: active
tags: ["build", "sync"]
related:
  - "./README.md"
  - "./_index.md"
---

# Build From Scratch Sync State

## Meta

- Synced commit: latest `main` snapshot at the time this folder was created (see `git log -1 --format=%H` on the repo root).
- Synced at: time of folder initialization.
- Scope: chapter coverage (01 → 15), file references, command-line invocations, secret names.
- Status: synced against the current `main` branch on first creation.

## Coverage Snapshot

The guide covers, end-to-end:

- Local toolchain prerequisites (Node 18+, Chromium browser, optional `go-task`, Cloudflare + Google accounts).
- Root scaffolding (`package.json`, `tsconfig.json`, `biome.json`, `vitest.shared.ts`, `.gitignore`).
- Manifest template generation with `{{GOOGLE_CLIENT_ID}}` and `{{CHROME_EXTENSION_PUBLIC_KEY}}` placeholders.
- `esbuild.config.mjs` orchestration: three build contexts (service worker, UI pages, content scripts), `define` constants, watch mode, static asset copying.
- Static extension assets (HTML/CSS, icons, theme, vendored player assets).
- Source code layers (`src/background/`, `src/popup/`, `src/offscreen/`, `src/annotate/`, `src/drive-auth/`, `src/storage-auth/`, `src/content/`, `src/shared/`, `src/types/`).
- Hosted player (`player/`, Vite, `sync-player.js`, `/api/drive` proxy).
- OAuth Worker (`worker/`, Wrangler, `ALLOWED_EXTENSION_ORIGINS`, secrets).
- The full `Taskfile.yml` alias catalog.
- `.env.example` walkthrough.
- Three Vitest contexts (root node, player jsdom, worker workerd).
- `Load unpacked` smoke test of the rebuilt extension.
- Tag-driven release flow and Chrome Web Store upload pipeline.
- Store-package validation rules.
- Quality gates (Biome, Knip, Husky, `docs:check`).

## Known Snapshot Gaps

- The actual code excerpts inside chapters are summarized descriptions; for the canonical implementation, always refer to the listed source files.
- When the repo adds new dependencies, new manifest permissions, or new Taskfile aliases, chapters `02`, `03`, `09`, and `10` must be reviewed.

## Re-syncing

After a non-trivial code change, re-walk the reader path, confirm each chapter's file references resolve, and update this file's "Synced commit" line with `git rev-parse HEAD`.
