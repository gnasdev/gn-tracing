/**
 * WebVTT artifacts derived from recording data.
 *
 * `captions.vtt` carries auto-chapters: one cue per reproduction step, so a
 * player (or any video tool) can navigate a recording by what happened rather
 * than by scrubbing. `transcript.vtt` is the reserved path for future
 * speech-to-text output — the player already renders it as a subtitle track
 * when a package ships one.
 */

import { buildReproSteps, type ReproStep } from "./repro-steps";
import { buildEventViews } from "./views";

export const CAPTIONS_FILENAME = "captions.vtt";
export const TRANSCRIPT_FILENAME = "transcript.vtt";

function vttTimestamp(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(
    seconds,
  ).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

/** One cue per repro step; the last cue runs to the recording's end. */
export function buildChaptersVtt(
  steps: ReproStep[],
  options: { durationMs?: number | null; tailMs?: number } = {},
): string {
  const tailMs = options.tailMs ?? 8_000;
  const cues = steps
    .filter((step) => typeof step.atMs === "number" && step.atMs >= 0)
    .map((step, index) => ({ atMs: step.atMs as number, label: step.label, index }));

  const lines = ["WEBVTT", ""];
  for (const [i, cue] of cues.entries()) {
    const next = cues[i + 1]?.atMs;
    const end = next ?? options.durationMs ?? cue.atMs + tailMs;
    lines.push(`${vttTimestamp(cue.atMs)} --> ${vttTimestamp(Math.max(end, cue.atMs + 1))}`);
    lines.push(`${i + 1} · ${cue.label}`);
    lines.push("");
  }
  return lines.join("\n");
}

const TEXT_ENCODER = new TextEncoder();

/**
 * Build `captions.vtt` bytes from a serialized events artifact (`events.json`
 * — array or `{events:[]}`, timestamps as epoch ms). Returns null when there
 * is nothing chapter-worthy — or when `startTime` is unknown, since without
 * it event epochs can't be turned into recording-relative cue times.
 */
export function buildCaptionsFromEventsJson(
  eventsJson: Uint8Array,
  startTime: number | null,
): Uint8Array | null {
  if (startTime == null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(eventsJson));
  } catch {
    return null;
  }
  const entries = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { events?: unknown[] })?.events)
      ? (parsed as { events: unknown[] }).events
      : [];
  if (entries.length === 0) {
    return null;
  }
  const steps = buildReproSteps(buildEventViews(entries, startTime));
  if (steps.length === 0) {
    return null;
  }
  return TEXT_ENCODER.encode(buildChaptersVtt(steps));
}
