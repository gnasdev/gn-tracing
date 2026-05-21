---
title: "Release And Update Checks"
description: "Current release packaging and popup update-check behavior."
type: feature
status: implemented
tags: ["release", "popup", "updates"]
source_paths:
  - "Taskfile.yml"
  - "manifest.template.json"
  - "scripts/check-store-package.mjs"
  - "src/background/service-worker.ts"
  - "src/popup/popup.ts"
  - "popup/popup.html"
related:
  - "../modules/drive-and-player.md"
  - "../shared/api-conventions.md"
  - "../compliance/chrome-web-store-submission.md"
---

# Release And Update Checks

## Meta

- Trạng thái: implemented
- Phạm vi: release zip packaging, Store package validation, popup update check, and contribution links
- Nguồn code: `Taskfile.yml`, `manifest.template.json`, `scripts/check-store-package.mjs`, `src/background/service-worker.ts`, `src/popup/popup.ts`, `popup/popup.html`
- Tuân thủ: Chrome Web Store submission
- Links: [Drive And Player](../modules/drive-and-player.md), [API Conventions](../shared/api-conventions.md), [Chrome Web Store Submission](../compliance/chrome-web-store-submission.md)

## Overview

GN Tracing release packaging produces a versioned extension directory for manual unpacked installation. The popup can check GitHub Releases for the latest available extension zip and surface a download link when a newer version exists.

## Release Packaging

Tag-driven release automation delegates extension build and packaging to `Taskfile.yml`. The packaged artifact is named `gn-tracing-extension-${tag}.zip` and contains the built extension under `gn-tracing-extension-${tag}/`.

Production builds require explicit OAuth and extension identity values so `dist/manifest.json` is generated from `manifest.template.json` with the Store OAuth client and Chrome extension public key. Store validation rejects unexpected broad host permissions and allows only the fixed GitHub API host used for update checks.

Standalone player deployment remains separate from extension release packaging.

## Popup Update Check

The popup sends `CHECK_FOR_UPDATE` to the service worker. The service worker reads the installed extension version, fetches the latest GitHub release metadata from `https://api.github.com/`, compares semver-like version numbers, and returns:

- installed version
- latest version
- whether an update is available
- release page URL
- extension zip download URL when a matching asset exists

The popup exposes both an automatic lightweight check on open and a user-triggered check that reports the current state. The update badge changes when a newer release is available, and the UI links users to the release/download surface rather than silently installing anything.

## Contribution Links

The popup includes direct GitHub and contribution entry points so users can inspect the project, report issues, or help improve the extension from the runtime UI.

## Constraints

- The extension does not auto-update itself from GitHub assets.
- The update check requires the fixed `https://api.github.com/` host permission.
- Release assets are expected to follow the extension zip naming convention so the service worker can choose the correct download URL.
- Chrome Web Store distribution remains governed by Store packaging and review requirements.
