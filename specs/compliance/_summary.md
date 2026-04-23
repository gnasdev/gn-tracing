# Compliance Summary

- **Status**: Bootstrap
- **Version**: 0.1.0

## Coverage

- `recording-runtime`: core orchestration, capture, and popup sync documented
- `drive-and-player`: auth, upload, replay URL generation, and standalone player documented
- shared message/data contracts documented

## Current Gaps

- build/deployment flow is only covered indirectly through module docs and README, not by a dedicated build module spec
- built-in player rendering internals are grouped under `drive-and-player` rather than documented as a separate module

## Orphan Risk

- medium: the repository has active code churn in player/build/runtime files, so specs should be re-synced whenever those paths change materially
