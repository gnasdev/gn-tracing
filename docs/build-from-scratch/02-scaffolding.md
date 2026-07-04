---
title: "02 - Scaffolding"
description: "Root configuration files for a fresh GN Tracing repository."
type: build
status: active
tags: ["build", "scaffold", "config"]
related:
  - "./01-prerequisites.md"
  - "./03-extension-root-manifest.md"
  - "./11-testing-three-contexts.md"
---

# 02 - Scaffolding

## Meta

- Goal: stand up the root configuration so chapters `03` → `08` can build on a real foundation.
- Verification: `npm install` succeeds and `npx tsc --noEmit` runs (it can fail because there are no sources yet, but the toolchain must be wired).

## 2.1 Repository Layout to Create

Even though this guide focuses on building the extension, the project has three roots, each with its own `package.json`:

```
<repo-root>/
├── package.json                  root extension + tooling
├── tsconfig.json
├── biome.json
├── vitest.config.ts
├── vitest.shared.ts
├── esbuild.config.mjs
├── Taskfile.yml
├── manifest.template.json
├── .env.example
├── .gitignore
├── player-standalone/            hosted replay player (chapter 07)
│   ├── package.json
│   ├── vite.config.ts
│   └── ...
└── worker/                       OAuth proxy Worker (chapter 08)
    ├── package.json
    ├── wrangler.toml
    └── ...
```

This chapter covers only the **root** scaffold. Chapters `07` and `08` add the other two.

## 2.2 Root `package.json`

Create `package.json` at the repo root (matches the version in this repo at the time of writing):

```json
{
  "name": "gn-tracing",
  "version": "1.3.0",
  "private": true,
  "license": "GPL-3.0-or-later",
  "scripts": {
    "prepare": "husky",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "lint": "biome lint . --files-ignore-unknown=true",
    "format": "biome format --write . --files-ignore-unknown=true",
    "format:check": "biome format . --files-ignore-unknown=true && npm run docs:check",
    "check": "biome check . --files-ignore-unknown=true && npm run docs:check",
    "check:write": "biome check --write . --files-ignore-unknown=true && npm run docs:check",
    "deadcode": "npx knip --no-progress",
    "docs:check": "node scripts/check-docs.mjs",
    "store:assets": "node scripts/generate-store-assets.mjs"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.4.15",
    "@types/chrome": "^0.0.287",
    "@vitest/coverage-v8": "4.1.9",
    "concurrently": "^8.2.2",
    "esbuild": "^0.28.0",
    "fast-check": "4.8.0",
    "husky": "^9.1.7",
    "sharp": "^0.34.5",
    "typescript": "^5.7.0",
    "vitest": "4.1.9"
  }
}
```

Install:

```bash
npm install
```

## 2.3 `tsconfig.json`

The root typechecks only the extension sources (`src/**/*.ts`). It targets ES2022 with bundler resolution:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["chrome"],
    "noEmit": true
  },
  "include": ["src/**/*.ts"]
}
```

`vitest` does not run TypeScript through `tsc`, so leaving `noEmit: true` is fine; chapter `09` exposes `task typecheck` for explicit runs via `npx tsc --noEmit`.

## 2.4 `biome.json`

Biome owns formatting, linting, and import organization for supported source files. The root config:

```json
{
  "$schema": "https://biomejs.dev/schemas/2.4.15/schema.json",
  "formatter": {
    "indentWidth": 2,
    "lineWidth": 100,
    "quoteStyle": "double",
    "semicolons": "always",
    "trailingCommas": "all"
  },
  "linter": {
    "rules": {
      "recommended": true
    }
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "double"
    }
  },
  "assist": {
    "actions": {
      "source": {
        "organizeImports": "on"
      }
    }
  },
  "files": {
    "includes": [
      "**/*.ts",
      "**/*.tsx",
      "**/*.js",
      "**/*.mjs",
      "**/*.cjs",
      "**/*.json"
    ],
    "ignore": [
      "dist",
      "node_modules",
      "coverage",
      "player/icons",
      "player/vendor",
      "store-assets"
    ]
  }
}
```

## 2.5 `vitest.shared.ts`

Vitest is shared across three contexts (root + player + worker) but only one file declares the shared options:

```ts
import { defineProject } from "vitest/config";

export const coverageThresholds = {
  lines: 60,
  functions: 60,
  statements: 60,
  branches: 55,
};

export default defineProject({
  test: {
    globals: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      thresholds: coverageThresholds,
    },
    include: ["**/*.{test,spec}.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
    ],
  },
});
```

The root `vitest.config.ts` then spreads this and adds the Chrome mock setup (chapter `11`).

## 2.6 `.gitignore`

```gitignore
node_modules/
dist/
coverage/
.env
*.pem
*.log
.DS_Store
.idea/
.vscode/
.knip/
```

## 2.7 Husky + Knip Scaffolding

`husky` is installed from `npm install`. After the first install, `npm run prepare` creates `.husky/pre-commit`. The actual hook body lives in chapter `15`.

`knip.json` lists the entry files that Knip must analyze:

```json
{
  "$schema": "knip.schema.json",
  "entry": [
    "src/background/service-worker.ts",
    "src/popup/popup.ts",
    "src/offscreen/offscreen.ts",
    "src/content/recording-events.ts",
    "src/content/in-page-capture.ts",
    "src/content/in-page-relay.ts",
    "src/drive-auth/drive-auth.ts",
    "src/history/history.ts",
    "src/settings/settings.ts",
    "scripts/check-docs.mjs",
    "scripts/check-store-package.mjs",
    "scripts/chrome-webstore.mjs",
    "scripts/generate-store-assets.mjs"
  ],
  "ignore": [
    "player/player.js",
    "dist",
    "player-standalone",
    "shared",
    "store-assets"
  ]
}
```

## You Should Now Have

- `npm install` completes without errors.
- `npx tsc --noEmit` exits 0 (or with "no input files" until chapter `06` adds sources).
- `npm run check` exits 0 once `scripts/check-docs.mjs` exists (chapter `15` adds it).
- `.husky/` exists with at least a `pre-commit` shell stub.

Move on to [03 - Extension Manifest](./03-extension-root-manifest.md).
