# @gn-tracing/sdk

In-page recorder that writes GN Tracing recording packages from any browser —
including mobile, where the extension cannot run.

## Why this exists

The extension is the better recorder wherever it can run. It captures tab video,
cross-origin request and response detail, and source-mapped console stacks, all
through the Chrome Debugger Protocol.

None of that is available on a phone. Chrome for Android has never supported
extensions; iOS has no browser engine that exposes `tabCapture` or `debugger`;
and `getDisplayMedia` is unsupported on both, so there is no fallback path to
video either. A page that instruments itself is the only recorder those users
can have.

## What it captures

| Source | How |
| --- | --- |
| console | patched `console.*`, `onerror`, `unhandledrejection` |
| network | patched `fetch` and `XMLHttpRequest` |
| websocket | wrapped `WebSocket` constructor |
| user events | click, contextmenu, scroll, focus, submit, named keys, SPA navigation |
| storage | `localStorage` / `sessionStorage` / same-origin cookies, at start and stop |
| screenshots | serialized DOM snapshot plus reporter annotations |
| instant replay | opt-in rolling DOM buffer, so the bug need not be reproduced |

Not captured, and declared as such in `metadata.capabilities`: tab video,
cross-origin request detail, cookies from other domains, and source-map
resolution.

### Screenshots are DOM snapshots, not pixels

No page API exposes the rendered viewport, and `getDisplayMedia` — the usual
escape hatch — does not exist on the mobile browsers this SDK is for. A
"screenshot" here is therefore a serialized DOM snapshot the player re-renders,
and every entry says so via `source.kind === "dom-snapshot"`. Canvas contents,
cross-origin iframes, and video frames are not reproduced, and that limitation
is written into `privacy.json` rather than left for a reader to discover.

The consequence for annotations: a `redact` region cannot be baked, because
there are no pixels to destroy. `annotateScreenshot` rejects a pending
redaction outright — pass the region's CSS selector as a mask selector *before*
capturing, so the content never enters the snapshot at all.

### Instant replay

Off by default. When enabled it snapshots the DOM on a timer and keeps a bounded
lookback, so a reporter can capture a bug that already happened:

```ts
const session = startRecording({ instantReplay: { windowMs: 30_000 } });
```

The buffer is bounded by time *and* bytes. On a page that rewrites its DOM
quickly the byte cap bites first, and `instant-replay.json` reports the span it
actually held (`coveredMs`) rather than the one it was configured for
(`windowMs`). If snapshots repeatedly overrun their time budget the recorder
disables itself and records why — a debugging aid that makes the host's page
stutter has stopped being one.

## Usage

```ts
import { startRecording } from "@gn-tracing/sdk";

const session = startRecording({ privacyProfile: "strict" });
// ... reproduce the bug ...
const shotId = session.captureScreenshot({ caption: "Total is wrong" });
session.annotateScreenshot(shotId, [
  { id: "a1", createdAt: Date.now(), type: "arrow", from: { x: 0.2, y: 0.2 }, to: { x: 0.7, y: 0.4 } },
]);
const { blob, filename } = await session.stop();
// Upload `blob` wherever your app already uploads user attachments.
```

Uploading is deliberately not included: an SDK embedded in someone's product
should not carry opinions about that product's storage or credentials.

## Guarantees

- **Same format.** Output goes through `@gn-tracing/replay-core/write`, so the
  hosted player, the MCP server, and the `gn-tracing-replay` skill read an SDK
  recording with no changes.
- **Same redaction.** Entries are redacted through
  `@gn-tracing/replay-core/redact` as they arrive, never at packaging time.
- **Clean teardown.** `stop()` restores every patched global to the exact
  reference it had before `start()`, and removes every listener it added.
- **Honest limits.** Buffer caps, and everything the SDK could not see, are
  written into `privacy.json` rather than left for a reader to infer.
