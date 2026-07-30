/**
 * Solid store for the active replay session.
 */
import { createStore } from "solid-js/store";
import type {
  ConsoleEntry,
  NetworkEntry,
  StorageArtifact,
  WebSocketEntry,
} from "../../../packages/replay-core/src/schema/capture";
import type { PackageMetadata } from "../../../packages/replay-core/src/schema/package";
import type { StorageProviderId } from "../lib/recording-ref";

export type ShellPhase = "intro" | "loading" | "password" | "error" | "player";

export type PanelId =
  | "report"
  | "activity"
  | "console"
  | "network"
  | "storage"
  | "elements"
  | "screenshots";

export interface LoadingEntry {
  key: string;
  label: string;
  status: "queued" | "loading" | "done" | "error";
  detail?: string;
}

export interface SessionState {
  phase: ShellPhase;
  errorMessage: string;
  passwordMessage: string;
  loadingMessage: string;
  loadingEntries: LoadingEntry[];
  provider: StorageProviderId | null;
  recordingId: string | null;
  pageUrl: string;
  metadata: PackageMetadata | null;
  consoleLogs: ConsoleEntry[];
  networkRequests: NetworkEntry[];
  webSockets: WebSocketEntry[];
  storageArtifact: StorageArtifact | null;
  userEvents: unknown[];
  report: unknown | null;
  privacy: unknown | null;
  videoUrl: string | null;
  screenshotUrls: string[];
  selectedPanel: PanelId;
  selectedConsoleIndex: number;
  selectedNetworkIndex: number;
  networkFilter: string;
}

const initial: SessionState = {
  phase: "intro",
  errorMessage: "",
  passwordMessage: "",
  loadingMessage: "",
  loadingEntries: [],
  provider: null,
  recordingId: null,
  pageUrl: "",
  metadata: null,
  consoleLogs: [],
  networkRequests: [],
  webSockets: [],
  storageArtifact: null,
  userEvents: [],
  report: null,
  privacy: null,
  videoUrl: null,
  screenshotUrls: [],
  selectedPanel: "report",
  selectedConsoleIndex: 0,
  selectedNetworkIndex: 0,
  networkFilter: "all",
};

export const [session, setSession] = createStore<SessionState>({ ...initial });

export function resetSession(): void {
  if (session.videoUrl) {
    URL.revokeObjectURL(session.videoUrl);
  }
  for (const url of session.screenshotUrls) {
    URL.revokeObjectURL(url);
  }
  setSession({ ...initial });
}

export function setPhase(phase: ShellPhase): void {
  setSession("phase", phase);
}

export function setError(message: string): void {
  setSession({ phase: "error", errorMessage: message });
}
