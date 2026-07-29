---
title: "04 - Extension Build With esbuild"
description: "How esbuild.config.mjs turns src/, popup/, settings/, history/, offscreen/, drive-auth/ and player/ into dist/."
type: build
status: active
tags: ["build", "esbuild", "extension"]
related:
  - "./02-scaffolding.md"
  - "./03-extension-root-manifest.md"
  - "./05-extension-static-assets.md"
---

# 04 - Extension Build With esbuild

## Meta

- Goal: turn `src/**/*.ts` plus the static `popup/`, `settings/`, `history/`, `offscreen/`, `drive-auth/`, `shared/`, `player/`, and `icons/` folders into a loadable `dist/` directory.
- Verification: `node esbuild.config.mjs --env development` produces a folder that chapter `12` can load as `Load unpacked`.

## 4.1 What the Script Does at a Glance

`esbuild.config.mjs` runs:

1. Loads `.env` (line by line, supports quoted values with escaped newlines).
2. Reads CLI flags `--env <development|production>` and `--watch`.
3. Computes `define` constants:
   - `__APP_ENV__` — `"development"` or `"production"`.
   - `__GOOGLE_CLIENT_ID__` — `.env` value or empty string.
   - `__GOOGLE_TOKEN_PROXY_URL__` — `.env` value with trailing slash stripped.
   - `__PLAYER_LOCAL_PORT__` — `.env` value or `5176`.
4. Runs three esbuild contexts in parallel (see `4.2`).
5. Generates `dist/manifest.json` from the template (chapter `03`).
6. Copies the static asset list (chapter `05`).

In watch mode it keeps the esbuild contexts running and watches every static asset path; changes trigger a debounced resync of assets.

## 4.2 The Three esbuild Contexts

All three share:

```js
{
  bundle: true,
  target: "chrome120",
  sourcemap: !isProductionBuild,
  minify: false,
  define: { __APP_ENV__: "...", __GOOGLE_CLIENT_ID__: "...", __GOOGLE_TOKEN_PROXY_URL__: "...", __PLAYER_LOCAL_PORT__: "..." },
}
```

### Context 1 — Service Worker (ESM)

```js
await esbuild.context({
  ...commonOptions,
  entryPoints: ["src/background/service-worker.ts"],
  outfile: "dist/background/service-worker.js",
  format: "esm",
});
```

Produces the MV3 service worker. ESM is required because the manifest declares `"background": { "type": "module" }`.

### Context 2 — UI Pages (IIFE)

```js
await esbuild.context({
  ...commonOptions,
  entryPoints: [
    { in: "src/popup/popup.ts", out: "popup/popup" },
    { in: "src/offscreen/offscreen.ts", out: "offscreen/offscreen" },
    { in: "src/annotate/annotate.ts", out: "annotate/annotate" },
    { in: "src/drive-auth/drive-auth.ts", out: "drive-auth/drive-auth" },
    { in: "src/storage-auth/storage-auth.ts", out: "storage-auth/storage-auth" },
  ],
  outdir: "dist",
  format: "iife",
});
```

Each entry compiles to `dist/<page>/<page>.js`. IIFE means the script encloses itself in a function and is safe to load from any HTML page.

### Context 3 — Content Scripts (IIFE, no sourcemap)

```js
await esbuild.context({
  ...commonOptions,
  entryPoints: [
    { in: "src/content/recording-events.ts", out: "content/recording-events" },
    { in: "src/content/in-page-capture.ts", out: "content/in-page-capture" },
    { in: "src/content/in-page-relay.ts", out: "content/in-page-relay" },
  ],
  outdir: "dist",
  format: "iife",
  sourcemap: false,
});
```

`chrome.scripting.executeScript` consumes these. Sourcemaps are disabled on purpose: the in-page payload must be self-contained and hard to reverse.

## 4.3 Static Asset Copy Pipeline

After the bundles finish (or in parallel during watch), the script runs:

```js
function copyStaticAssets() {
  for (const entry of STATIC_ASSET_ENTRIES) {
    if (entry.type === "text") copyTextFile(entry.src, entry.dest);
    else if (entry.type === "dir") copyDir(entry.src, entry.dest);
    else copyFile(entry.src, entry.dest);
  }
}
```

`STATIC_ASSET_ENTRIES` enumerates every file or directory that ends up under `dist/` (chapter `05` lists them). `copyDir` walks recursively; `copyTextFile` lets you transform text files (none currently transforms); `copyFile` is a straight copy.

## 4.4 Manifest Generation

`generateManifest("dist/manifest.json")`:

1. Validates Chrome identity (chapter `03`).
2. Substitutes `{{GOOGLE_CLIENT_ID}}` and `{{CHROME_EXTENSION_PUBLIC_KEY}}`.
3. Overwrites `version` with `package.json#version`.
4. Calls `addTokenProxyHostPermission(manifest)` to append the Worker origin when set (chapter `08`).
5. Writes the JSON to `dist/manifest.json` with a final newline.

## 4.5 Watch Mode

`--watch`:

- Starts all three esbuild contexts in watch mode.
- Spins up `fs.watch` over every static asset path and the manifest template.
- Debounces by 300 ms using an mtime+size signature; only re-syncs when something actually changed.

This is what powers `task watch` and `task dev` (chapter `09`).

## 4.6 Production vs Development Differences

| Aspect | Development | Production |
| --- | --- | --- |
| `__APP_ENV__` | `"development"` | `"production"` |
| Sourcemaps | on for SW + UI, off for content | off everywhere |
| `CHROME_EXTENSION_ID` required | no | yes |
| `dist/` removed before build | no | yes |

## 4.7 CLI Examples

```bash
# Default (production because no flag)
node esbuild.config.mjs

# Explicit dev build
node esbuild.config.mjs --env development

# Production build (same as default but explicit)
node esbuild.config.mjs --env production

# Watch and rebuild
node esbuild.config.mjs --watch
```

Equivalent Task aliases (chapter `09`): `task build`, `task dist`, `task watch`.

## You Should Now Have

- `dist/manifest.json` with placeholders replaced.
- `dist/background/service-worker.js` (ESM).
- `dist/popup/popup.js`, `dist/offscreen/offscreen.js`, `dist/annotate/annotate.js`, `dist/drive-auth/drive-auth.js`, `dist/storage-auth/storage-auth.js` (IIFE).
- `dist/content/recording-events.js`, `dist/content/in-page-capture.js`, `dist/content/in-page-relay.js` (IIFE, no sourcemap).
- A watcher that re-syncs when you edit a static asset.

Move on to [05 - Static Assets](./05-extension-static-assets.md).
