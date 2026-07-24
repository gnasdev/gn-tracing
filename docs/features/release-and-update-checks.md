---
title: "Release Packaging"
description: "Current release packaging, Store package validation, and contribution links."
type: feature
status: implemented
tags: ["release", "popup"]
source_paths:
  - "Taskfile.yml"
  - "manifest.template.json"
  - "scripts/check-store-package.mjs"
  - "src/popup/popup.ts"
  - "popup/popup.html"
related:
  - "../modules/drive-and-player.md"
  - "./extension-surfaces.md"
  - "../shared/api-conventions.md"
  - "../compliance/chrome-web-store-submission.md"
---

# Release Packaging

## Meta

- Trạng thái: implemented
- Phạm vi: release zip packaging, Store package validation, and contribution links
- Nguồn code: `Taskfile.yml`, `manifest.template.json`, `scripts/check-store-package.mjs`, `src/popup/popup.ts`, `popup/popup.html`
- Tuân thủ: Chrome Web Store submission
- Links: [Drive And Player](../modules/drive-and-player.md), [Extension Surfaces](./extension-surfaces.md), [API Conventions](../shared/api-conventions.md), [Chrome Web Store Submission](../compliance/chrome-web-store-submission.md)

## Overview

GN Tracing release packaging produces a versioned extension directory for manual unpacked installation. Users install or upgrade by loading the published extension zip (or Chrome Web Store distribution). The popup does not check GitHub Releases for updates or self-install newer builds.

## Release Packaging

Tag-driven release automation delegates extension build and packaging to `Taskfile.yml`. The packaged artifact is named `gn-tracing-extension-${tag}.zip` and contains the built extension under `gn-tracing-extension-${tag}/`.

Production builds require explicit OAuth and extension identity values so `dist/manifest.json` is generated from `manifest.template.json` with the Store OAuth client and Chrome extension public key. Store validation rejects unexpected broad host permissions and allows only the fixed Google OAuth/Drive hosts (plus an optional token-proxy origin).

Standalone player deployment remains separate from extension release packaging.

## Contribution Links

The popup includes direct GitHub and contribution entry points so users can inspect the project, report issues, or help improve the extension from the runtime UI.

## Constraints

- The extension does not auto-update itself from GitHub assets and does not poll `api.github.com` for version comparison.
- Chrome Web Store distribution remains governed by Store packaging and review requirements.
