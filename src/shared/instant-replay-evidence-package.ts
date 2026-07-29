/**
 * Encode Instant Replay evidence rings into package artifact JSON strings
 * matching the shapes Record finalize already writes.
 */

import type { InstantReplayEvidenceBundle } from "../../packages/replay-core/src/capture/instant-replay-evidence";
import type {
  ConsoleEntry,
  NetworkEntry,
  StorageSnapshot,
  WebSocketEntry,
} from "../../packages/replay-core/src/schema/capture";
import type { PrivacyRedactionSettings } from "../types/messages";
import { evidenceBundleHasData } from "./instant-replay-evidence-bridge";
import { redactConsoleEntry } from "./privacy-redaction";

export type InstantReplayPackageArtifacts = Partial<{
  instantReplay: string;
  console: string;
  network: string;
  websocket: string;
  storage: string;
}>;

export interface RedactEvidenceFns {
  network: (entry: NetworkEntry) => NetworkEntry;
  websocket: (entry: WebSocketEntry) => WebSocketEntry;
  storage: (snapshot: StorageSnapshot) => StorageSnapshot;
}

/**
 * Build attachable artifact JSON for the offscreen screenshot/IR package path.
 * Empty kinds are omitted so the package stays lean.
 */
export function buildInstantReplayPackageArtifacts(input: {
  instantReplayJson: string;
  evidence: InstantReplayEvidenceBundle | null | undefined;
  privacySettings: PrivacyRedactionSettings;
  redact?: RedactEvidenceFns;
}): InstantReplayPackageArtifacts {
  const artifacts: InstantReplayPackageArtifacts = {
    instantReplay: input.instantReplayJson,
  };

  if (!evidenceBundleHasData(input.evidence)) {
    return artifacts;
  }

  const evidence = input.evidence!;
  const consoleEntries = evidence.console.map((entry) => {
    const redacted = redactConsoleEntry(entry, input.privacySettings);
    return redacted.value as ConsoleEntry;
  });
  if (consoleEntries.length > 0) {
    artifacts.console = JSON.stringify(consoleEntries);
  }

  const networkEntries = evidence.network.map((entry) =>
    input.redact ? input.redact.network(entry) : entry,
  );
  if (networkEntries.length > 0) {
    artifacts.network = JSON.stringify({
      schemaVersion: 2,
      entries: networkEntries,
    });
  }

  const websocketEntries = evidence.websocket.map((entry) =>
    input.redact ? input.redact.websocket(entry) : entry,
  );
  if (websocketEntries.length > 0) {
    artifacts.websocket = JSON.stringify(websocketEntries);
  }

  const storageSnaps = evidence.storage.map((snap) =>
    input.redact ? input.redact.storage(snap) : snap,
  );
  if (storageSnaps.length > 0) {
    artifacts.storage = JSON.stringify({
      schemaVersion: 1,
      snapshots: storageSnaps,
    });
  }

  return artifacts;
}
