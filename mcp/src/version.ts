/**
 * The version both MCP transports report in `initialize`.
 *
 * It lives here rather than in each transport because a client that sees
 * `gn-tracing-remote 1.0.0` and `gn-tracing 1.2.0` for the same tool surface has
 * no way to tell which is stale. `scripts/check-mcp-release.mjs` asserts this
 * equals `mcp/package.json#version`, so the published package and the handshake
 * cannot drift.
 */
export const MCP_SERVER_VERSION = "1.0.0";
