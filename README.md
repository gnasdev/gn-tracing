# GN Tracing OSS

Open-source companion to [GN Tracing](https://tracing.gnas.dev/) — a browser
extension that records a tab (video, console, network, WebSocket) into a
shareable replay.

This repo carries the parts of the project that are useful on their own:

| Path | What it is |
|------|------------|
| `mcp/` | `gn-tracing-mcp` — MCP server that lets a coding agent read a replay link or a `gn-tracing-*.zip` package: console errors with source-mapped stacks, failed requests, and the user timeline. |
| `packages/replay-core/` | `@gn-tracing/replay-core` — runtime-agnostic parser for recording packages (zip reader, artifact models, agent summary, query, report). |
| `src/shared/` | Shared helpers the replay-core tests compare against, synced from the main repo. |

## Quick start

```bash
cd mcp
npm ci
npm run build   # → dist/gn-tracing-mcp.mjs
```

Wire `node dist/gn-tracing-mcp.mjs` into your MCP client — details in
[`mcp/README.md`](mcp/README.md).

## Tests

```bash
npm install     # root dev deps (vitest)
npm test
```

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
