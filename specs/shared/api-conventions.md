# API Conventions

- **Status**: Active
- **Version**: 0.1.0

## Internal Message Contracts

- popup and auth page never mutate shared state directly; they send commands to the service worker
- offscreen messages must include `target: "offscreen"` so the service worker can ignore them in its main command handler
- long-running flows return progress through fire-and-forget runtime messages plus `chrome.storage.session` state sync

## External APIs

- `chrome.tabCapture`
  produces a tab stream ID that is forwarded to the offscreen document.
- `chrome.debugger`
  enables `Network`, `Runtime`, `Log`, and best-effort `Debugger` domains.
- `chrome.identity`
  primary auth mechanism for Chrome; Edge uses `launchWebAuthFlow` plus locally stored access token fallback.
- Google Drive REST APIs
  used for token verification, multipart upload, permission creation, and token revocation.
