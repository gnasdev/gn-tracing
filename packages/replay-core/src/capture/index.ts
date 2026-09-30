/**
 * `@gn-tracing/replay-core/capture` — instrumenting a live page.
 *
 * Everything here runs inside the page with no privileged APIs: patched
 * `console`, `fetch`, `XMLHttpRequest`, and `WebSocket`, plus storage
 * snapshots. That constraint is what makes the module reusable — the extension
 * injects it into a MAIN world where `chrome.*` is unreachable, and the browser
 * SDK imports it as ordinary page code.
 *
 * What it deliberately cannot do is what needs the debugger protocol:
 * cross-origin response bodies, source-map resolution, and tab video.
 */

export * from "./dom-snapshot";
export * from "./in-page-capture";
export * from "./instant-replay";
export * from "./instant-replay-evidence";
export * from "./key-event";
