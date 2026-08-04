/**
 * Coordinated STOP for in-page capture: MAIN cleanup must finish (and its
 * entry postMessages must be delivered to the service worker) before the SW
 * continues to finalizeCurrentSession.
 *
 * Order:
 * 1. Bridge posts STOP control with requestId
 * 2. MAIN runs installInPageCapture cleanup (emits stop storage + inflight network)
 * 3. MAIN posts STOP_COMPLETE
 * 4. Bridge awaits every in-flight entry delivery to the SW
 * 5. Bridge answers the original chrome.tabs.sendMessage
 */

export const DEFAULT_IN_PAGE_STOP_TIMEOUT_MS = 3_000;

export function makeInPageStopRequestId(): string {
  return `ipc-stop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface InPageStopDrainDeps {
  requestId: string;
  /** Post STOP control to MAIN (includes requestId). */
  postStopToMain: (requestId: string) => void;
  /**
   * Subscribe for STOP_COMPLETE from MAIN. Invokes `onComplete` once for this
   * requestId. Returns unsubscribe.
   */
  onStopComplete: (requestId: string, onComplete: () => void) => () => void;
  /**
   * Snapshots Promises for entry deliveries already handed to the SW.
   * Called when STOP_COMPLETE arrives so late flushes from cleanup are included
   * if their handlers already scheduled sendMessage.
   */
  snapshotPendingDeliveries: () => readonly Promise<unknown>[];
  timeoutMs?: number;
}

/**
 * Run the bridge-side stop drain. Resolves only after STOP_COMPLETE and all
 * pending entry deliveries settle (or timeout).
 */
export async function awaitInPageStopDrain(deps: InPageStopDrainDeps): Promise<{
  ok: boolean;
  error?: string;
  timedOut?: boolean;
}> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_IN_PAGE_STOP_TIMEOUT_MS;

  const completePromise = new Promise<"complete">((resolve) => {
    const unsubscribe = deps.onStopComplete(deps.requestId, () => {
      unsubscribe();
      resolve("complete");
    });
    // post after subscribe so a synchronous MAIN (tests) cannot race
    deps.postStopToMain(deps.requestId);
  });

  const timeoutPromise = new Promise<"timeout">((resolve) => {
    setTimeout(() => resolve("timeout"), timeoutMs);
  });

  const winner = await Promise.race([completePromise, timeoutPromise]);
  // Always drain whatever entry deliveries exist at this point.
  await Promise.allSettled(deps.snapshotPendingDeliveries());

  // Second microtask turn: cleanup postMessages may have scheduled entry
  // handlers that add new deliveries after STOP_COMPLETE was observed.
  await Promise.resolve();
  await Promise.allSettled(deps.snapshotPendingDeliveries());

  if (winner === "timeout") {
    return {
      ok: false,
      timedOut: true,
      error: "In-page capture stop timed out before cleanup finished.",
    };
  }
  return { ok: true };
}
