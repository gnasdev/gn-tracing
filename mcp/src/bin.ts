#!/usr/bin/env node
/**
 * `gn-tracing-mcp` — the local MCP server entrypoint.
 *
 * Flags:
 *   --allow-dir <path>      Directory local `.zip` packages may be read from
 *                           (repeatable). Local reading is OFF until given.
 *   --player-origin <url>   Override the hosted player origin (dev/self-hosted).
 *
 * Hosted replay links work with no flags at all.
 */

import { createLocalRecordingStore, runStdioServer } from "./stdio";

interface ParsedArgs {
  allowedDirectories: string[];
  playerOrigin?: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const allowedDirectories: string[] = [];
  let playerOrigin: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--allow-dir" && argv[index + 1]) {
      allowedDirectories.push(argv[index + 1]);
      index += 1;
    } else if (arg.startsWith("--allow-dir=")) {
      allowedDirectories.push(arg.slice("--allow-dir=".length));
    } else if (arg === "--player-origin" && argv[index + 1]) {
      playerOrigin = argv[index + 1];
      index += 1;
    } else if (arg.startsWith("--player-origin=")) {
      playerOrigin = arg.slice("--player-origin=".length);
    }
  }

  return { allowedDirectories, playerOrigin };
}

async function main(): Promise<void> {
  const { allowedDirectories, playerOrigin } = parseArgs(process.argv.slice(2));
  const store = createLocalRecordingStore({ allowedDirectories, playerOrigin });

  // stdout is the protocol channel; diagnostics go to stderr only.
  process.stderr.write(
    `gn-tracing MCP server ready (local files: ${
      allowedDirectories.length > 0 ? allowedDirectories.join(", ") : "disabled"
    })\n`,
  );

  await runStdioServer(store, { input: process.stdin, output: process.stdout });
}

main().catch((error: unknown) => {
  process.stderr.write(`gn-tracing MCP server failed: ${String(error)}\n`);
  process.exitCode = 1;
});
