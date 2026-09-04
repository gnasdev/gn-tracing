/**
 * Hosted-only recording store for remote MCP (no local files, no passwords).
 */

import { createRecordingStore } from "../../../../mcp/src/resolver";
import {
  buildPackageDownloadUrl,
  createHttpSource,
  DEFAULT_PLAYER_ORIGIN,
  ReplayError,
} from "../../../../packages/replay-core/src/index";
import type { Env } from "../../env";
import { MAX_REMOTE_ENTRY_BYTES, MAX_REMOTE_PACKAGE_BYTES } from "./limits";

export function createRemoteRecordingStore(env: Pick<Env, "PLAYER_ORIGIN">) {
  const playerOrigin = (env.PLAYER_ORIGIN ?? "").trim() || DEFAULT_PLAYER_ORIGIN;

  return createRecordingStore({
    allowLocalFiles: false,
    maxEntryBytes: MAX_REMOTE_ENTRY_BYTES,
    openSource: async (locator) => {
      if (locator.kind !== "remote") {
        throw new ReplayError(
          "INVALID_SOURCE",
          "This endpoint reads hosted recordings only.",
          "Run the local gn-tracing MCP server to read a downloaded .zip package.",
        );
      }
      return createHttpSource(buildPackageDownloadUrl(locator.ref, playerOrigin), {
        maxBytes: MAX_REMOTE_PACKAGE_BYTES,
        label: "recording download proxy",
      });
    },
  });
}
