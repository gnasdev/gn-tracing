---
title: "15 - Quality Gates"
description: "Biome, Knip, Husky pre-commit, and docs:check that every change must clear."
type: build
status: active
tags: ["build", "quality", "biome", "knip", "husky"]
related:
  - "./02-scaffolding.md"
  - "./11-testing-three-contexts.md"
  - "./README.md"
---

# 15 - Quality Gates

## Meta

- Goal: keep formatting, linting, dead-code removal, doc hygiene, and a fast feedback loop on every change without manual intervention.
- Verification: `npm run check`, `npm run deadcode`, and the Husky pre-commit hook all pass on a clean tree.

## 15.1 Biome

Single toolchain for formatting, linting, and import organization. Configured in `biome.json` (chapter `02`).

```bash
npm run lint          # lint only
npm run format        # format + write
npm run format:check  # format check + docs:check
npm run check         # lint + format + docs:check
npm run check:write   # fix in place + docs:check
```

Coverage of file types:

- TypeScript and JS — full linting.
- JSON — formatting only.
- Markdown — Biome ignores Markdown by design; `docs:check` covers it.

## 15.2 Knip Dead Code

Knip looks for unused exports, unused dependencies, and unreachable files.

```bash
npm run deadcode     # npx knip --no-progress
```

`knip.json` (chapter `02`) lists every entry file Knip must consider. Anything reported by Knip is either:

- An unused export that should be removed.
- A stale `entry` line in `knip.json` (entry file renamed or deleted).

`ignore` paths cover the prebuilt `player/player.js` (third-party-style artifact), `dist/`, `player-standalone/`, `shared/`, and `store-assets/`.

## 15.3 Husky Pre-commit Hook

`.husky/pre-commit` runs three checks for every staged change:

```bash
#!/usr/bin/env bash
set -e

# 1. Biome auto-fix for staged files only.
npx biome check --write --staged --files-ignore-unknown=true

# 2. Markdown hygiene.
npm run docs:check

# 3. Vitest for the impacted tests.
npx vitest related --run --passWithNoTests \
  -- "$(git diff --cached --name-only --diff-filter=ACM | grep '\.ts$' | grep -v '^player-standalone/' | grep -v '^worker/' || true)"
```

Three guardrails:

- `--staged` keeps Biome from rewriting files outside the commit.
- `docs:check` enforces LF endings, no trailing whitespace, and valid relative `.md` links (chapter `15.4`).
- `vitest related` runs only the tests that touch the staged files, which keeps pre-commit fast.

`player-standalone/` and `worker/` are intentionally excluded from the root Vitest call because they own their own test runners; their pre-commit guards are managed in their own `package.json` `prepare` scripts.

## 15.4 `docs:check` and the Markdown Rules

`scripts/check-docs.mjs` enforces:

- LF line endings — no CR anywhere in any `.md` file.
- Final newline — every file ends with `\n`.
- No trailing whitespace on any line.
- Every `related:` entry and inline bracket-link target ending in `.md` exists on disk.

A failure looks like:

```text
docs/foo.md:42 links to missing markdown file: ./bar.md
```

Fix:

- If the referenced file is wrong, fix the link.
- If the referenced file should exist, create it.
- If the file is intentionally outside the docs tree, link to it differently (e.g. a non-`.md` URL or a bare URL).

This check is also wired into `npm run format:check`, `npm run check`, and `npm run check:write`, so `docs/` is never silently skipped.

## 15.5 Pre-push Considerations

There is no pre-push hook by default. The release pipeline is protected by `.github/workflows/test.yml`, which runs:

```yaml
- npm ci
- (cd player-standalone && npm ci)
- (cd worker && npm ci)
- npm run typecheck
- (cd player-standalone && npm run typecheck)
- (cd worker && npm run typecheck)
- npm run test:coverage
- (cd player-standalone && npm run test)
- (cd worker && npm run test)
```

Coverage thresholds from chapter `11` are enforced.

## 15.6 Putting It All Together

Every change should pass:

```bash
npm run check        # biome + docs:check
npm run deadcode     # unused export check
task test:all        # root + player + worker tests
```

That is the minimum bar. The Store flow (chapter `13`) and the tag-driven release (chapter `13`) add their own gates.

## 15.7 Notes

- Biome 2.x supports the `assist.actions.source.organizeImports` directive used by `npm run lint`; `npm run format` keeps imports sorted.
- Markdown link detection scans both bracket-style `.md` links and the `related:` block; both must point at real files.
- Coverage thresholds are shared across all three Vitest contexts via `vitest.shared.ts` (chapter `11`); adjust one threshold only if you adjust it in all three.

## You Should Now Have

- A clean `npm run check` on every supported file.
- A working pre-commit hook that runs Biome, the doc check, and the affected tests.
- A green Knip report.
- A `task test:all` that exits 0.

You have now finished the [Build GN Tracing From Scratch](./README.md) guide.
