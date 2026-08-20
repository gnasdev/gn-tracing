/**
 * Shared mutable session state for the service worker.
 *
 * Split out of `service-worker.ts` as the state-owner module the file's other
 * handler groups (recording lifecycle, drawing overlay, screenshot/instant
 * replay, upload history, popup state sync) read and mutate. Moved verbatim:
 * `activeRecording` is read or written from ~160 call sites across
 * `service-worker.ts`, so this module keeps the exact same object identity and
 * mutation style (field assignment, not replacement) rather than introducing a
 * new access pattern that every call site would have to adopt at once.
 *
 * `sessions` / `sessionArtifacts` / `drawingColor` are exposed through
 * getter/setter pairs instead of as `let` exports: an imported `let` binding is
 * read-only from the importing module, so the handful of call sites that
 * reassign the whole value (not just a field) need a function to do it through.
 */

import { DEFAULT_DRAW_COLOR } from "../shared/drawing";
import type {
  PrivacyRedactionSettings,
  ProgressItemSnapshot,
  RecordingSessionSummary,
} from "../types/messages";
import type {
  CaptureEnvironment,
  RecordingDrawStroke,
  RecordingUserEvent,
  RedactionHit,
} from "../types/recording";
import { elapsedFromRecordingStart } from "./recording-clock";
import type { UploadSettingsStore } from "./settings-store";
import { DEFAULT_PRIVACY_REDACTION_SETTINGS } from "./settings-store";

export interface ActiveRecordingState {
  sessionId: string | null;
  isRecording: boolean;
  tabId: number | null;
  startTime: number | null;
  stopTime: number | null;
  tabUrl: string | null;
  tabTitle: string | null;
  environment: CaptureEnvironment | null;
  userEvents: RecordingUserEvent[];
  drawingStrokes: RecordingDrawStroke[];
  drawingClears: number[];
  drawingOverlayActive: boolean;
  redactionHits: RedactionHit[];
  privacyLimitations: string[];
  privacySettings: PrivacyRedactionSettings;
  recordingSettings: UploadSettingsStore | null;
}

export interface SessionArtifacts {
  consoleLogs?: string;
  networkRequests?: string;
  webSocketLogs?: string;
  report?: string;
  userEvents?: string;
  drawing?: string;
  privacy?: string;
  diagnostics?: string;
  storage?: string;
  dom?: string;
  screenshotDataUrl?: string;
  duration: number;
  url: string;
  startTime: number | null;
  stopTime: number | null;
}

const STORAGE_KEY_ARTIFACTS = "gn_tracing_session_artifacts";

/** The one active/most-recent recording session. Mutated in place by field. */
export const activeRecording: ActiveRecordingState = {
  sessionId: null,
  isRecording: false,
  tabId: null,
  startTime: null,
  stopTime: null,
  tabUrl: null,
  tabTitle: null,
  environment: null,
  userEvents: [],
  drawingStrokes: [],
  drawingClears: [],
  drawingOverlayActive: false,
  redactionHits: [],
  privacyLimitations: [],
  privacySettings: DEFAULT_PRIVACY_REDACTION_SETTINGS,
  recordingSettings: null,
};

/** In-flight upload tasks by session id, so a second upload request can join instead of duplicating work. */
export const activeUploadTasks = new Map<string, Promise<void>>();

// Provider connectivity is cached separately from popup state so UI reloads
// can show a stable snapshot while a background verification refreshes it.
export const googleDriveState = {
  isConnected: false,
  checkedAt: 0,
};
export const dropboxState = {
  isConnected: false,
  checkedAt: 0,
};

let sessions: RecordingSessionSummary[] = [];
let sessionArtifacts: Record<string, SessionArtifacts> = {};
let drawingColor = DEFAULT_DRAW_COLOR;

export function getSessions(): RecordingSessionSummary[] {
  return sessions;
}

export function setSessions(next: RecordingSessionSummary[]): void {
  sessions = next;
}

export function getSessionArtifacts(): Record<string, SessionArtifacts> {
  return sessionArtifacts;
}

export function setSessionArtifacts(next: Record<string, SessionArtifacts>): void {
  sessionArtifacts = next;
}

export function getDrawingColor(): string {
  return drawingColor;
}

export function setDrawingColor(color: string): void {
  drawingColor = color;
}

export function createSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function cloneProgressItems(items: ProgressItemSnapshot[]): ProgressItemSnapshot[] {
  return items.map((item) => ({ ...item }));
}

export function getElapsedMs(now = Date.now()): number {
  return elapsedFromRecordingStart(activeRecording.startTime, now);
}

export function recordActiveRedactionHits(hits: RedactionHit[] | undefined): void {
  if (!hits?.length || !activeRecording.sessionId) {
    return;
  }
  activeRecording.redactionHits.push(...hits);
  if (activeRecording.redactionHits.length > 10000) {
    activeRecording.redactionHits.splice(0, activeRecording.redactionHits.length - 10000);
  }
}

export function addActivePrivacyLimitation(message: string): void {
  if (!message || activeRecording.privacyLimitations.includes(message)) {
    return;
  }
  activeRecording.privacyLimitations.push(message);
}

export function sortSessions(items: RecordingSessionSummary[]): RecordingSessionSummary[] {
  return [...items].sort((left, right) => {
    const rightTs = right.stopTime || right.startTime || 0;
    const leftTs = left.stopTime || left.startTime || 0;
    return rightTs - leftTs;
  });
}

export function getSession(sessionId: string): RecordingSessionSummary | undefined {
  return sessions.find((session) => session.id === sessionId);
}

export function setSession(session: RecordingSessionSummary): void {
  const existingIndex = sessions.findIndex((item) => item.id === session.id);
  if (existingIndex >= 0) {
    sessions[existingIndex] = session;
  } else {
    sessions.push(session);
  }
  sessions = sortSessions(sessions);
}

export function patchSession(
  sessionId: string,
  patch: Partial<RecordingSessionSummary>,
): RecordingSessionSummary | null {
  const existing = getSession(sessionId);
  if (!existing) {
    return null;
  }
  const updated: RecordingSessionSummary = {
    ...existing,
    ...patch,
    items: patch.items ? cloneProgressItems(patch.items) : cloneProgressItems(existing.items),
  };
  setSession(updated);
  return updated;
}

export async function loadPersistedArtifacts(): Promise<Record<string, SessionArtifacts>> {
  try {
    const result = await chrome.storage.session.get(STORAGE_KEY_ARTIFACTS);
    const stored = result[STORAGE_KEY_ARTIFACTS];
    if (!stored || typeof stored !== "object") {
      return {};
    }
    return stored as Record<string, SessionArtifacts>;
  } catch {
    return {};
  }
}

export async function saveArtifactsToStorage(): Promise<void> {
  try {
    await chrome.storage.session.set({
      [STORAGE_KEY_ARTIFACTS]: sessionArtifacts,
    });
  } catch {
    // Ignore storage errors.
  }
}
