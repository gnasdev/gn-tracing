---
title: "Compliance Summary"
description: "Current documentation coverage and remaining knowledge-base gaps."
type: compliance
status: active
tags: ["compliance", "coverage"]
related:
  - "../modules/recording-runtime.md"
  - "../modules/drive-and-player.md"
  - "../modules/privacy-and-redaction.md"
  - "../modules/replay-player.md"
  - "../features/extension-surfaces.md"
  - "../shared/data-models.md"
  - "./privacy-policy.md"
  - "./terms-of-service.md"
  - "./chrome-web-store-submission.md"
---

# Compliance Summary

## Meta

- Trạng thái: active
- Phạm vi: documentation coverage and orphan-risk summary
- Nguồn code: `src/`, `player/`, `player-standalone/`
- Tuân thủ: Không áp dụng
- Links: [Recording Runtime](../modules/recording-runtime.md), [Cloud Storage And Player](../modules/drive-and-player.md), [Privacy And Redaction](../modules/privacy-and-redaction.md), [Replay Player](../modules/replay-player.md), [Extension Surfaces](../features/extension-surfaces.md), [Shared Data Models](../shared/data-models.md), [Privacy Policy](./privacy-policy.md), [Terms of Service](./terms-of-service.md), [Chrome Web Store Submission](./chrome-web-store-submission.md)

## Coverage

- `recording-runtime`: core orchestration, capture, and popup sync documented
- `drive-and-player` (Cloud Storage And Player): multi-cloud auth, upload, public share, namespaced replay URLs, and standalone proxies for Google Drive + Dropbox documented
- `privacy-and-redaction`: privacy profiles, redaction policy, event sanitization, DOM masking, and privacy artifact semantics documented
- `replay-player`: package loading, password unlock, provider-aware downloads/proxies, source-map diagnostics rendering, and inspection UX documented
- `extension-surfaces`: popup, Settings (storage provider + folder), auth page, full upload history, and UI ownership boundaries documented
- release/deploy flow: covered through `drive-and-player`, `shared/api-conventions`, `_index.md`, and `README.md`
- shared message/data contracts documented
- Chrome Web Store readiness docs cover privacy policy language, permission justifications, multi-cloud data usage disclosures, remote code notes, and reviewer test instructions
- Public legal / branding pages ship with the standalone player:
  - OAuth application homepage: `https://tracing.gnas.dev/app/`
  - Privacy Policy: `https://tracing.gnas.dev/privacy/`
  - Terms of Service: `https://tracing.gnas.dev/terms/`
  - Replay player (not OAuth homepage): `https://tracing.gnas.dev/`

## Telemetry-Free Guarantee

- No product analytics SDK reports browsing activity.
- OAuth tokens and recording package bodies are not logged to remote telemetry.
- Browser console may show high-level auth/upload failure messages without token or package payloads (see privacy policy).

## Current Gaps

- Google OAuth branding / app verification still depends on Cloud Console review after public URLs are linked
- Dropbox app verification (if required by Dropbox) is outside the Chrome Web Store package itself
- OneDrive / Microsoft was removed from the product (personal OD cannot reliably serve anonymous player downloads); no Azure app setup is required

## Orphan Risk

- low-to-medium: the repository has active code churn in player/build/runtime files, so docs should be re-synced whenever those paths change materially
