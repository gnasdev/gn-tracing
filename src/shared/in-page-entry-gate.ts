/**
 * Pure gate for bridged in-page capture entries (RECORDING_INPAGE_ENTRY).
 *
 * During stop, the service worker sets `isRecording = false` before the
 * MAIN→relay→worker drain finishes. Entries for the draining session
 * (final storage snapshot, late fetch/XHR) must still be accepted.
 */

export interface InPageEntryGateInput {
  sessionId: string;
  activeSessionId: string | null;
  senderTabId: number | undefined | null;
  activeTabId: number | null;
  isRecording: boolean;
  /** Session still accepting bridge traffic after stop, until drain completes. */
  drainSessionId: string | null;
}

/**
 * Whether a bridged in-page entry should be buffered into StorageManager.
 */
export function shouldAcceptInPageEntry(input: InPageEntryGateInput): boolean {
  if (!input.sessionId || input.sessionId !== input.activeSessionId) {
    return false;
  }
  if (input.senderTabId == null || input.senderTabId !== input.activeTabId) {
    return false;
  }
  if (input.isRecording) {
    return true;
  }
  return input.drainSessionId != null && input.sessionId === input.drainSessionId;
}
