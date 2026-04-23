# Project Context

- **Status**: Active
- **Version**: 0.1.0

## Product Context

GN Tracing is designed for debugging and replaying real tab sessions without a backend. The extension collects runtime evidence directly from the active tab, then packages that evidence into Google Drive-hosted artifacts plus a player URL.

## Architectural Shape

- MV3 extension with a service worker as the orchestration boundary
- offscreen document for `MediaRecorder` because MV3 service workers cannot hold media capture directly
- popup and auth page as thin UI clients driven by service-worker-owned state
- standalone player kept separate from extension packaging, but fed by the same uploaded artifacts

## Non-Functional Constraints

- recording state is ephemeral and memory-backed
- service worker dormancy is mitigated with a `chrome.alarms` keepalive
- upload success depends on Google Drive OAuth and publicly shareable file permissions
- external player hosting is optional and user-configurable
