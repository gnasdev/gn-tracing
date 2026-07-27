/**
 * Bundles the MCP server into a single runnable ESM file.
 *
 * The server is TypeScript that imports `packages/replay-core` by relative path,
 * so it needs a bundle step before Node can run it — the same shape as the
 * extension build. Output goes to `mcp/dist/`, which is git-ignored, so the
 * documented setup step is `task mcp:build` before wiring up a client.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [resolve(here, "src/bin.ts")],
  outfile: resolve(here, "dist/gn-tracing-mcp.mjs"),
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  sourcemap: false,
  // No banner: esbuild keeps the entry's own shebang, and adding a second one
  // puts `#!` on line 2, which is a syntax error.
  logLevel: "info",
});
