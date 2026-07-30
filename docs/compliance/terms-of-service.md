---
title: "GN Tracing Terms of Service"
description: "Public terms language for GN Tracing extension use, multi-cloud uploads, and hosted replay."
type: compliance
status: active
tags: ["terms", "chrome-web-store", "oauth", "multi-cloud"]
related:
  - "./privacy-policy.md"
  - "./chrome-web-store-submission.md"
  - "../modules/drive-and-player.md"
---

# GN Tracing Terms of Service

## Meta

- Trạng thái: active
- Phạm vi: public terms language for extension use, multi-cloud upload, hosted player, liability, and contact
- Nguồn code: `player/public/terms/index.html`
- Tuân thủ: OAuth consent screens / Chrome Web Store public legal URLs
- Links: [Privacy Policy](./privacy-policy.md), [Chrome Web Store Submission](./chrome-web-store-submission.md), [Cloud Storage And Player](../modules/drive-and-player.md)

## Public URL

- Production: `https://tracing.gnas.dev/terms/`
- Alternate clean path: `https://tracing.gnas.dev/terms`
- OAuth application homepage (branding): `https://tracing.gnas.dev/app/`

The canonical HTML page is deployed with the standalone player on Cloudflare Pages
(`player/public/terms/index.html`). Update that page when these terms change.

## Summary For Maintainers

- Users own their recordings; GN Tracing only processes them to package, upload to the user's chosen cloud storage (Google Drive or Dropbox), and replay.
- Acceptable-use and sharing responsibility sit with the user (especially link-readable cloud files and password handling).
- Service is provided as-is; open-source licenses still apply to published source.
- Contact: GitHub issues or `ngosangns@gmail.com`.
