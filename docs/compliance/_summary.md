---
title: "Compliance Summary"
description: "Current documentation coverage and remaining knowledge-base gaps."
type: compliance
status: active
tags: ["compliance", "coverage"]
related:
  - "../modules/recording-runtime.md"
  - "../modules/drive-and-player.md"
  - "../shared/data-models.md"
  - "./privacy-policy.md"
  - "./chrome-web-store-submission.md"
---

# Compliance Summary

## Meta

- Trạng thái: active
- Phạm vi: documentation coverage and orphan-risk summary
- Nguồn code: `src/`, `player/`, `player-standalone/`
- Tuân thủ: Không áp dụng
- Links: [Recording Runtime](../modules/recording-runtime.md), [Drive And Player](../modules/drive-and-player.md), [Shared Data Models](../shared/data-models.md), [Privacy Policy](./privacy-policy.md), [Chrome Web Store Submission](./chrome-web-store-submission.md)

## Coverage

- `recording-runtime`: core orchestration, capture, and popup sync documented
- `drive-and-player`: auth, upload, replay URL generation, and standalone player documented
- release/deploy flow: covered through `drive-and-player`, `shared/api-conventions`, `_index.md`, and `README.md`
- shared message/data contracts documented
- Chrome Web Store readiness docs now cover privacy policy language, permission justifications, data usage disclosures, remote code notes, and reviewer test instructions

## Current Gaps

- built-in player rendering internals are grouped under `drive-and-player` rather than documented as a separate module
- privacy policy still needs to be published at a stable public URL before Store submission

## Orphan Risk

- low-to-medium: the repository has active code churn in player/build/runtime files, so docs should be re-synced whenever those paths change materially
