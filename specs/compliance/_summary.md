# Compliance Summary

- **Status**: Bootstrap
- **Version**: 0.1.0

## Coverage

- `recording-runtime`: core orchestration, capture, and popup sync documented
- `drive-and-player`: auth, upload, replay URL generation, and standalone player documented
- release/deploy flow: covered through `drive-and-player`, `shared/api-conventions`, `_index.md`, and `README.md`
- shared message/data contracts documented

## Current Gaps

- built-in player rendering internals are grouped under `drive-and-player` rather than documented as a separate module

## Orphan Risk

- low-to-medium: the repository has active code churn in player/build/runtime files, so specs should be re-synced whenever those paths change materially
