/**
 * Instant replay: a rolling window of what the page looked like *before* the
 * bug was reported.
 *
 * The problem it solves is the one every bug report has: by the time someone
 * decides to record, the interesting moment has passed, and "can you reproduce
 * it?" is often the end of the investigation. So the buffer runs continuously
 * and keeps only a short lookback, and a report packages whatever the buffer
 * happens to be holding.
 *
 * Three constraints shape the design, and all three are privacy or performance
 * constraints rather than feature ones:
 *
 * - **Bounded by time *and* bytes.** A time-only window is unbounded in memory
 *   on a page that rewrites its DOM sixty times a second. When the byte cap
 *   bites first, the covered window shrinks, and `coveredMs` reports the truth
 *   rather than the configured `windowMs`.
 * - **Nothing leaves the browser until a report is made.** Frames live in
 *   memory here. A caller may persist them, but this module never does.
 * - **It stops when it starts costing.** If snapshotting repeatedly overruns
 *   its budget, the recorder disables itself instead of degrading the page it
 *   is supposed to be observing.
 */

import type { InstantReplayArtifact, InstantReplayFrame } from "../schema/annotation";
import { type DomSnapshotOptions, estimateSnapshotBytes, serializeDomTree } from "./dom-snapshot";

export interface InstantReplayOptions extends DomSnapshotOptions {
  /** Lookback window. Frames older than this are evicted. */
  windowMs?: number;
  /** Milliseconds between snapshots. */
  intervalMs?: number;
  /** Total retained bytes across frames. */
  maxBytes?: number;
  /**
   * Snapshot budget. Overrunning it this many times in a row disables the
   * recorder — a debugging aid that makes the page janky has stopped being one.
   */
  maxSnapshotMs?: number;
  maxConsecutiveOverruns?: number;
}

export const DEFAULT_INSTANT_REPLAY_WINDOW_MS = 30_000;
export const DEFAULT_INSTANT_REPLAY_INTERVAL_MS = 1_000;
export const DEFAULT_INSTANT_REPLAY_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_SNAPSHOT_MS = 50;
export const DEFAULT_MAX_CONSECUTIVE_OVERRUNS = 3;

interface BufferedFrame extends InstantReplayFrame {
  bytes: number;
}

/**
 * The buffer itself, with no timers or DOM. Kept separate so its eviction rules
 * — the part that decides what a reader will and will not see — are testable
 * without a browser.
 */
export class InstantReplayBuffer {
  readonly windowMs: number;
  readonly maxBytes: number;

  #frames: BufferedFrame[] = [];
  #bytes = 0;
  #dropped = 0;

  constructor(options: { windowMs?: number; maxBytes?: number } = {}) {
    this.windowMs = options.windowMs ?? DEFAULT_INSTANT_REPLAY_WINDOW_MS;
    this.maxBytes = options.maxBytes ?? DEFAULT_INSTANT_REPLAY_MAX_BYTES;
  }

  push(frame: Omit<InstantReplayFrame, "relativeMs">, bytes: number): void {
    this.#frames.push({ ...frame, relativeMs: 0, bytes });
    this.#bytes += bytes;
    this.#evict(frame.capturedAt);
  }

  /** Drops frames outside the time window, then trims until under the byte cap. */
  #evict(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.#frames.length > 1 && this.#frames[0].capturedAt < cutoff) {
      this.#bytes -= this.#frames[0].bytes;
      this.#frames.shift();
      this.#dropped += 1;
    }
    // Always keep the newest frame: a report with one stale frame is still
    // worth more than a report with none.
    while (this.#frames.length > 1 && this.#bytes > this.maxBytes) {
      this.#bytes -= this.#frames[0].bytes;
      this.#frames.shift();
      this.#dropped += 1;
    }
  }

  get frameCount(): number {
    return this.#frames.length;
  }

  get byteCount(): number {
    return this.#bytes;
  }

  get droppedFrames(): number {
    return this.#dropped;
  }

  /** Discards everything. Called on a fixed cycle so a buffer never lingers. */
  clear(): void {
    this.#frames = [];
    this.#bytes = 0;
  }

  /**
   * Materialises the artifact. `coveredMs` is the span actually retained, which
   * is shorter than `windowMs` whenever the byte cap evicted first — a reader
   * that trusted `windowMs` would think it was looking at 30 seconds of history
   * when it had 4.
   */
  toArtifact(): InstantReplayArtifact {
    const first = this.#frames[0];
    const last = this.#frames[this.#frames.length - 1];
    return {
      schemaVersion: 1,
      windowMs: this.windowMs,
      coveredMs: first && last ? last.capturedAt - first.capturedAt : 0,
      droppedFrames: this.#dropped,
      frames: this.#frames.map(({ bytes: _bytes, ...frame }) => ({
        ...frame,
        relativeMs: first ? frame.capturedAt - first.capturedAt : 0,
      })),
    };
  }
}

export interface InstantReplayRecorder {
  /** Take one snapshot now. Returns false when the recorder has disabled itself. */
  snapshot(): boolean;
  /** Stop the timer and release listeners. */
  stop(): void;
  /** Snapshot of the buffer as an artifact, or null when nothing was retained. */
  toArtifact(): InstantReplayArtifact | null;
  readonly buffer: InstantReplayBuffer;
  readonly disabled: boolean;
  /** Why the recorder disabled itself, if it did. */
  readonly disabledReason: string | null;
}

interface RecorderScope {
  document: Document;
  location: { href: string };
  innerWidth: number;
  innerHeight: number;
  setInterval: (handler: () => void, ms: number) => number;
  clearInterval: (id: number) => void;
  performance?: { now(): number };
}

/**
 * Starts snapshotting on an interval.
 *
 * `now()` is injected so tests can drive time; production passes nothing and
 * gets `Date.now`.
 */
export function startInstantReplay(
  scope: RecorderScope,
  options: InstantReplayOptions = {},
  now: () => number = () => Date.now(),
): InstantReplayRecorder {
  const buffer = new InstantReplayBuffer({
    windowMs: options.windowMs,
    maxBytes: options.maxBytes,
  });
  const intervalMs = options.intervalMs ?? DEFAULT_INSTANT_REPLAY_INTERVAL_MS;
  const maxSnapshotMs = options.maxSnapshotMs ?? DEFAULT_MAX_SNAPSHOT_MS;
  const maxOverruns = options.maxConsecutiveOverruns ?? DEFAULT_MAX_CONSECUTIVE_OVERRUNS;

  let disabled = false;
  let disabledReason: string | null = null;
  let consecutiveOverruns = 0;
  let timer: number | null = null;

  const measure = (): number =>
    scope.performance && typeof scope.performance.now === "function"
      ? scope.performance.now()
      : now();

  const snapshot = (): boolean => {
    if (disabled) {
      return false;
    }

    const startedAt = measure();
    let serialized: ReturnType<typeof serializeDomTree>;
    try {
      serialized = serializeDomTree(scope.document, options);
    } catch (cause) {
      disabled = true;
      disabledReason = `DOM snapshot failed: ${cause instanceof Error ? cause.message : String(cause)}`;
      stop();
      return false;
    }
    const elapsed = measure() - startedAt;

    buffer.push(
      {
        capturedAt: now(),
        documentUrl: scope.location.href,
        viewport: { width: scope.innerWidth, height: scope.innerHeight },
        root: serialized.root,
      },
      estimateSnapshotBytes(serialized.root),
    );

    // A page heavy enough to blow the budget repeatedly gets left alone. Jam
    // does the same thing, and for the same reason: a recorder that makes the
    // app stutter changes the behaviour it was installed to observe.
    if (elapsed > maxSnapshotMs) {
      consecutiveOverruns += 1;
      if (consecutiveOverruns >= maxOverruns) {
        disabled = true;
        disabledReason = `DOM snapshots took over ${maxSnapshotMs}ms ${maxOverruns} times in a row; instant replay disabled to keep the page responsive.`;
        stop();
      }
    } else {
      consecutiveOverruns = 0;
    }

    return !disabled;
  };

  function stop(): void {
    if (timer !== null) {
      scope.clearInterval(timer);
      timer = null;
    }
  }

  timer = scope.setInterval(snapshot, intervalMs);

  return {
    snapshot,
    stop,
    buffer,
    toArtifact: () => (buffer.frameCount > 0 ? buffer.toArtifact() : null),
    get disabled() {
      return disabled;
    },
    get disabledReason() {
      return disabledReason;
    },
  };
}
