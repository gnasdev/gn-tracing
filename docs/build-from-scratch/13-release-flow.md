---
title: "13 - Release Flow"
description: "Tag-driven GitHub Actions release of gn-tracing-extension-<tag>.zip and Chrome Web Store publish."
type: build
status: active
tags: ["build", "release", "github-actions", "store"]
related:
  - "./10-environment-and-secrets.md"
  - "./14-store-package-validation.md"
  - "./15-quality-gates.md"
---

# 13 - Release Flow

## Meta

- Goal: cut a real release end-to-end: commit on `main` → push a `v*` tag → GitHub Actions produces the zip → optionally push to the Chrome Web Store.
- Verification: a successful workflow run uploads `gn-tracing-extension-<tag>.zip` to the matching GitHub Release page.

## 13.1 Two Release Surfaces

There are two distinct ship targets:

1. **GitHub Releases** — the `.zip` artifact users download to install manually.
2. **Chrome Web Store** — the auto-update path that Chrome itself maintains.

Both flow through `task dist` + `task release:zip`. The Store has an additional gate (`task store:check` → `store:zip` → `store:upload` → `store:publish`).

## 13.2 Tag-Driven `.github/workflows/release.yml`

The workflow triggers on `push tags: 'v*'` and runs on `ubuntu-latest` with `contents: write`. It expects five repository secrets:

| Secret | Source | Used by |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | chapter `01`/`10` | `manifest.json#oauth2.client_id` and `__GOOGLE_CLIENT_ID__` |
| `CHROME_EXTENSION_ID` | chapter `01` (derived) | `esbuild.config.mjs` validation |
| `CHROME_EXTENSION_PUBLIC_KEY` | chapter `01` | `manifest.json#key` and ID derivation |
| `CHROME_EXTENSION_PRIVATE_KEY` | chapter `01` | optional release signing |
| `CLOUDFLARE_API_TOKEN` | optional, only if you also push the player at release time | `task player:deploy` |

Without all five secrets present, the workflow logs a warning but continues with the placeholder-derived values — production builds need all five to succeed.

The workflow steps:

1. Checkout with `fetch-depth: 0` (so tags work).
2. `npm ci` at the repo root.
3. `task release:ci` runs:
   - `task dist` — production build.
   - `task release:zip` — wraps `dist/` into `gn-tracing-extension-<tag>.zip`.
4. Upload the artifact via `softprops/action-gh-release@v2` against the just-pushed tag.

## 13.3 Cutting a Local Release

If you want the zip without involving GitHub:

```bash
GITHUB_REF_NAME=v1.4.0 task release:ci
ls gn-tracing-extension-v1.4.0.zip
unzip -l gn-tracing-extension-v1.4.0.zip | head
```

`release:zip` extracts the zip into `gn-tracing-extension-${GITHUB_REF_NAME:-local}/` which is the folder users see after download.

## 13.4 Chrome Web Store Pipeline

After chapter `14` validates the package, the Store pipeline is:

```bash
task store:zip       # produces gn-tracing-store.zip
task store:status    # inspect the current Store item
task store:upload    # uploads the zip via the Chrome Web Store API
task store:publish   # submits the uploaded item for review
```

Or all in one go:

```bash
task store:release
```

The `scripts/chrome-webstore.mjs` CLI wraps the Chrome Web Store API; it reads credentials from the environment so they never hit the repo.

## 13.5 Versioning Conventions

- The `version` field in `package.json` is the single source of truth. The manifest's `version` syncs from it during build.
- Tag format: `vMAJOR.MINOR.PATCH` matching semver.
- `git tag` + `git push origin <tag>` triggers the workflow. Force-pushing tags is supported but breaks reviewers; prefer `git tag -d` + `git push origin :refs/tags/<tag>` + a fresh tag when needed.

## 13.6 Release Checklist

Run this before tagging:

1. `npm run format:check` — clean.
2. `npm run check` — clean.
3. `npm run test:coverage` — meets thresholds in all three contexts.
4. `task dist:all` — extension + player built.
5. `task store:check` — passes locally.
6. Confirm `CHANGELOG` / release notes are written.
7. Push the tag.

## 13.7 Rolling Back

- For GitHub Releases, delete the tag and the release, then push a corrected tag.
- For the Chrome Web Store, `task store:status` shows whether the new submission is in review, accepted, or live. If you need to pull a bad build, push a new patch version with a fix; Chrome auto-updates installed clients.

## You Should Now Have

- A working tag-driven release flow that produces a downloadable zip.
- Either a manual or scripted way to ship to the Chrome Web Store.

Move on to [14 - Store Package Validation](./14-store-package-validation.md).
