---
title: "GN Tracing Terms of Service"
description: "Public terms language for GN Tracing extension use, Drive uploads, and hosted replay."
type: compliance
status: active
tags: ["terms", "chrome-web-store", "google-oauth"]
related:
  - "./privacy-policy.md"
  - "./chrome-web-store-submission.md"
  - "../modules/drive-and-player.md"
---

# GN Tracing Terms of Service

## Meta

- Trạng thái: active
- Phạm vi: public terms language for extension use, Drive upload, hosted player, liability, and contact
- Nguồn code: `player-standalone/public/terms/index.html`
- Tuân thủ: Google OAuth consent screen / Chrome Web Store public legal URLs
- Links: [Privacy Policy](./privacy-policy.md), [Chrome Web Store Submission](./chrome-web-store-submission.md), [Drive And Player](../modules/drive-and-player.md)

## Public URL

- Production: `https://tracing.gnas.dev/terms/`
- Alternate clean path: `https://tracing.gnas.dev/terms`

The canonical HTML page is deployed with the standalone player on Cloudflare Pages
(`player-standalone/public/terms/index.html`). Update that page when these terms change.

## Summary For Maintainers

- Users own their recordings; GN Tracing only processes them to package, upload to the user's Drive, and replay.
- Acceptable-use and sharing responsibility sit with the user (especially link-readable Drive files).
- Service is provided as-is; open-source licenses still apply to published source.
- Contact: GitHub issues or `ngosangns@gmail.com`.
