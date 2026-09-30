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

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createLocalRecordingStore, runStdioServer } from "./stdio";

interface ParsedArgs {
  allowedDirectories: string[];
  playerOrigin?: string;
  /**
   * Arguments the parser did not consume: an unknown flag, a known flag with no
   * value, or a known flag with an empty value. Returned rather than written to
   * a `warn` sink so `parseArgs` stays a pure function — the caller owns the
   * stderr channel, and a test can assert the outcome without capturing output.
   */
  unrecognized: string[];
}

/** Reads `--flag value` or `--flag=value`; `consumed` counts extra argv slots. */
function readFlag(
  flag: string,
  argv: string[],
  index: number,
): { value: string; consumed: number } | null {
  const arg = argv[index];
  if (arg === flag) {
    const next = argv[index + 1];
    return next === undefined ? null : { value: next, consumed: 1 };
  }
  if (arg.startsWith(`${flag}=`)) {
    return { value: arg.slice(flag.length + 1), consumed: 0 };
  }
  return null;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const allowedDirectories: string[] = [];
  const unrecognized: string[] = [];
  let playerOrigin: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const directory = readFlag("--allow-dir", argv, index);
    if (directory) {
      // An empty value would resolve to the process cwd, silently allow-listing
      // the whole working directory — refuse it instead of widening access.
      if (directory.value) {
        allowedDirectories.push(directory.value);
      } else {
        unrecognized.push(argv[index]);
      }
      index += directory.consumed;
      continue;
    }

    const origin = readFlag("--player-origin", argv, index);
    if (origin) {
      if (origin.value) {
        playerOrigin = origin.value;
      } else {
        unrecognized.push(argv[index]);
      }
      index += origin.consumed;
      continue;
    }

    // This CLI takes no positional arguments, so anything left is a mistake.
    unrecognized.push(argv[index]);
  }

  return { allowedDirectories, playerOrigin, unrecognized };
}

async function main(): Promise<void> {
  const { allowedDirectories, playerOrigin, unrecognized } = parseArgs(process.argv.slice(2));
  const store = createLocalRecordingStore({ allowedDirectories, playerOrigin });

  // stdout is the protocol channel; diagnostics go to stderr only.
  if (unrecognized.length > 0) {
    process.stderr.write(
      `gn-tracing MCP server: ignoring unrecognized argument(s): ${unrecognized.join(", ")}\n` +
        "Supported flags: --allow-dir <path>, --player-origin <url>\n",
    );
  }
  process.stderr.write(
    `gn-tracing MCP server ready (local files: ${
      allowedDirectories.length > 0 ? allowedDirectories.join(", ") : "disabled"
    })\n`,
  );

  await runStdioServer(store, { input: process.stdin, output: process.stdout });
}

/**
 * Only start a server when run as a program. Tests import `parseArgs` from here,
 * and an unguarded `main()` would attach to the test runner's stdin. `realpath`
 * matters because npm installs `bin` entries as symlinks, which `import.meta.url`
 * reports resolved while `process.argv[1]` does not.
 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(`gn-tracing MCP server failed: ${String(error)}\n`);
    process.exitCode = 1;
  });
}
