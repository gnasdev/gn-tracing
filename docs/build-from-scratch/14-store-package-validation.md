---
title: "14 - Store Package Validation"
description: "scripts/check-store-package.mjs rules and how to fix violations before uploading."
type: build
status: active
tags: ["build", "store", "validation", "security"]
related:
  - "./03-extension-root-manifest.md"
  - "./04-extension-build-esbuild.md"
  - "./13-release-flow.md"
---

# 14 - Store Package Validation

## Meta

- Goal: understand every rule `scripts/check-store-package.mjs` enforces and how to address each one.
- Verification: `task store:check` (which runs the script after `task dist`) exits 0 with no warnings.

## 14.1 What the Script Does

The script walks `dist/` and verifies:

1. `dist/manifest.json` parses and contains the expected fields.
2. No `.map` files are present (the production build disables sourcemaps, but double-check).
3. No `eval(` or `new Function(` strings appear in any bundled `.js`.
4. No HTML file references a remote `<script src="https://...">`.
5. Permissions and host_permissions match the agreed manifest.

It exits 1 with file:line diagnostics on violation. It is the same script `task store:check` runs.

## 14.2 Rule-by-Rule

### Manifest Health

```js
const manifest = JSON.parse(fs.readFileSync("dist/manifest.json", "utf8"));
assert(manifest.manifest_version === 3, "expected manifest_version 3");
assert(typeof manifest.version === "string", "version missing");
assert(Array.isArray(manifest.permissions), "permissions missing");
```

Fix: rebuild with `task dist` and confirm `validateChromeExtensionIdentity()` did not throw.

### No Source Maps in Production Build

```js
for (const file of walkSync("dist")) {
  if (file.endsWith(".map")) error("found source map: " + file);
}
```

Fix: nothing in your code; the production build strips them. If you see one, you reintroduced `sourcemap: true` for an entry — chapter `04`.

### No `eval` / `new Function`

```js
const text = fs.readFileSync(file, "utf8");
if (/(\beval\b|\bnew\s+Function\b)/.test(text)) error("dynamic eval found: " + file);
```

Fix: replace `eval(...)` with explicit dispatch and remove `new Function(...)` patterns. If a third-party library insists, document the exception and replace it.

### No Remote Scripts in HTML

```js
const html = fs.readFileSync(file, "utf8");
if (/<script[^>]*src=["']https?:\/\//i.test(html)) error("remote script: " + file);
```

Fix: bundle the script via esbuild and reference it relatively (`<script src="popup.js"></script>`). The vendored `player/vendor/luna/*` UMDs are local, so they pass.

### Permissions Sanity

```js
const allowed = new Set([
  "tabCapture", "offscreen", "debugger", "scripting",
  "activeTab", "storage", "alarms", "identity",
]);
for (const perm of manifest.permissions ?? []) {
  if (!allowed.has(perm)) warn("unknown permission: " + perm);
}
```

Fix: this is just a warning to make reviewers look. Add new permissions to the allowlist only after updating the Chrome Web Store disclosure doc (`docs/compliance/chrome-web-store-submission.md`).

## 14.3 Running It Standalone

```bash
task dist                    # produces dist/
node scripts/check-store-package.mjs
```

Or via Task:

```bash
task store:check
```

`store:check` adds:

- `npx tsc --noEmit`
- `npm audit --omit=dev`
- `task player:typecheck`
- `(cd player && npm audit)`
- `task dist`
- `node scripts/check-store-package.mjs`

This is the gate you must clear before `task store:zip`.

## 14.4 Common Fixes

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `unknown permission` | new manifest permission | add to script allowlist or roll back the change |
| `dynamic eval found` | minifier or inline eval | use the explicit form |
| `remote script` | dev-only CDN include | bundle via esbuild |
| `manifest_version` | production build skipped | re-run `task dist` |

## You Should Now Have

- A green `task store:check` against the current `dist/`.
- Mental model of every rule and how to recover when it trips.

Move on to [15 - Quality Gates](./15-quality-gates.md).
