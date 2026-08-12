/**
 * MediaRecorder session helpers shared by the offscreen/media document.
 *
 * Keeps stream acquisition + recorder lifecycle out of the packaging entry so
 * that file stays under the size budget while message contracts stay stable.
 */

import { describeFirefoxArmInvalidStateMessage } from "../shared/firefox-arm-copy";

export type SessionRecordingSnapshot = {
  blob: Blob;
  mimeType: string;
  createdAt: number;
};

export type CaptureStreamResult = {
  stream: MediaStream;
  loopbackTabAudio: boolean;
};

/** A display-capture attempt that failed, classified for the UI. */
export type DisplayCaptureFailure = {
  /**
   * True when the user dismissed the browser's share picker or refused the
   * permission. Not a defect — the UI should say so plainly and stay idle.
   */
  cancelled: boolean;
  message: string;
};

/**
 * Turn a getDisplayMedia rejection into something a user can act on.
 *
 * The raw DOMException messages leak implementation detail ("getDisplayMedia
 * requires transient activation from a user gesture") and give the user no next
 * step, so each known name gets an actionable message instead. Unknown names
 * keep the original text rather than hiding it.
 */
export function describeDisplayCaptureError(error: unknown): DisplayCaptureFailure {
  const name = error instanceof DOMException ? error.name : "";
  const raw = error instanceof Error ? error.message.trim() : String(error ?? "").trim();

  switch (name) {
    case "NotAllowedError":
    case "AbortError":
      return {
        cancelled: true,
        message: "Screen sharing was cancelled, so recording did not start.",
      };
    case "InvalidStateError":
      return {
        cancelled: false,
        message: describeFirefoxArmInvalidStateMessage(),
      };
    case "NotFoundError":
      return {
        cancelled: false,
        message: "No shareable window or screen was offered by the browser. Try again.",
      };
    case "NotReadableError":
      return {
        cancelled: false,
        message:
          "The system blocked screen capture. On macOS, allow the browser under " +
          "System Settings → Privacy & Security → Screen Recording, then restart it.",
      };
    case "OverconstrainedError":
    case "TypeError":
      return {
        cancelled: false,
        message: `The browser rejected the capture settings${raw ? `: ${raw}` : "."}`,
      };
    case "SecurityError":
      return {
        cancelled: false,
        message: "Screen capture is not permitted in this context.",
      };
    default:
      return {
        cancelled: false,
        message: raw ? `Could not start screen capture: ${raw}` : "Could not start screen capture.",
      };
  }
}

export async function acquireCaptureStream(
  streamId: string,
  mode: string,
): Promise<CaptureStreamResult> {
  if (mode === "display-media" || !streamId) {
    // Firefox (and any host without tabCapture): user-facing picker.
    //
    // Neither surface hint is honoured by Firefox 153 — measured
    // getSupportedConstraints(): displaySurface=false, cursor=false,
    // logicalSurface=false, mediaSource=true. Its picker therefore only offers a
    // window or a whole screen, never a single tab, and there is no constraint
    // that narrows it. `preferCurrentTab` (Chromium-proprietary) and
    // `displaySurface` (standard) are sent for engines that do honour them;
    // unknown keys are ignored.
    const displayConstraints = {
      video: {
        preferCurrentTab: true,
        displaySurface: "browser",
        width: { ideal: 1920, max: 1920 },
        height: { ideal: 1080, max: 1080 },
        frameRate: { ideal: 30, max: 30 },
      },
      audio: false,
    } as DisplayMediaStreamOptions;
    const stream = await navigator.mediaDevices.getDisplayMedia(displayConstraints);
    return { stream, loopbackTabAudio: false };
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
        maxWidth: 1920,
        maxHeight: 1080,
        maxFrameRate: 30,
      },
    } as MediaTrackConstraints,
  });
  return { stream, loopbackTabAudio: false };
}

/** Minimal recorder surface needed to stop and flush — keeps this unit testable. */
export type StoppableRecorder = {
  readonly state: string;
  requestData: () => void;
  stop: () => void;
};

/**
 * Stop a recorder and wait for its final chunk before the caller releases the
 * capture stream.
 *
 * MediaRecorder finalization is asynchronous. Firefox discards the recorder's
 * final buffer when the source tracks are stopped in the same task, producing a
 * zero-byte blob and an upload that fails with "snapshot no longer available".
 * `flush` must resolve from the recorder's own `stop` handler, so tracks are only
 * released after the blob exists.
 *
 * Returns `flushed: false` when the stop event never arrived within `timeoutMs`,
 * which is the caller's signal to force-release the stream itself.
 */
export async function stopRecorderAndWaitForFlush(
  recorder: StoppableRecorder,
  flush: Promise<void>,
  timeoutMs: number,
): Promise<{ flushed: boolean }> {
  try {
    recorder.requestData();
    recorder.stop();
  } catch (error) {
    console.warn("[GN Tracing] MediaRecorder stop failed:", error);
  }

  let flushed = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  await Promise.race([
    flush.then(() => {
      flushed = true;
    }),
    new Promise<void>((resolve) => {
      timeoutId = setTimeout(resolve, timeoutMs);
    }),
  ]);

  if (timeoutId) {
    clearTimeout(timeoutId);
  }

  return { flushed };
}

export async function waitForFirstFrame(stream: MediaStream): Promise<number | null> {
  const [videoTrack] = stream.getVideoTracks();
  if (!videoTrack) {
    return null;
  }

  if (!videoTrack.muted && videoTrack.readyState === "live") {
    return Date.now();
  }

  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;

  try {
    await Promise.race([
      new Promise<void>((resolve) => {
        video.onloadeddata = () => resolve();
      }),
      new Promise<void>((resolve) => {
        const track = videoTrack;
        track.onunmute = () => resolve();
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("first-frame timeout")), 2000);
      }),
    ]);
    return Date.now();
  } catch {
    return null;
  } finally {
    video.srcObject = null;
    videoTrack.onunmute = null;
  }
}

/** Just enough of MediaStream to choose a container/codec pair. */
export type RecorderTrackSource = Pick<MediaStream, "getAudioTracks">;

/** Container/codec candidates, most preferred first, for each stream shape. */
const AUDIO_VIDEO_MIME_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
] as const;

const VIDEO_ONLY_MIME_CANDIDATES = [
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
] as const;

/**
 * Choose a recorder mime type that matches the tracks the stream actually has.
 *
 * Declaring an audio codec for a stream with no audio track makes Firefox's
 * MediaRecorder stall silently and permanently: `isTypeSupported` still returns
 * true, `start()` succeeds, `state` stays "recording", no `error` fires — and no
 * `dataavailable` or `stop` event ever arrives, so the recording is lost. Measured
 * on Firefox 153 with a video-only stream:
 *
 *   video/webm;codecs=vp8,opus → 0 chunks in 4s, stop event never fired
 *   video/webm;codecs=vp8      → 4 chunks in 4s, stop event in 7ms
 *
 * Firefox's `getDisplayMedia` returns video only even when audio is requested, so
 * the audio-bearing codec string must never be used for that path. Firefox 153
 * also reports no vp9 support, which is why it always landed on the broken
 * `vp8,opus` string.
 *
 * Passing no stream keeps the audio-bearing preference, which is correct for
 * Chromium tab capture (video + tab audio).
 */
export function pickRecorderMimeType(
  stream?: RecorderTrackSource | null,
  isTypeSupported: (type: string) => boolean = (type) => MediaRecorder.isTypeSupported(type),
): string {
  const hasAudio = stream ? stream.getAudioTracks().length > 0 : true;
  const candidates = hasAudio ? AUDIO_VIDEO_MIME_CANDIDATES : VIDEO_ONLY_MIME_CANDIDATES;

  for (const candidate of candidates) {
    if (isTypeSupported(candidate)) {
      return candidate;
    }
  }

  // Empty string lets the browser choose its own default container.
  return "";
}

export type ActiveMediaSession = {
  recorder: MediaRecorder;
  stream: MediaStream;
  sessionId: string;
  chunks: Blob[];
  shouldDiscard: boolean;
  playbackAudioContext: AudioContext | null;
  playbackSourceNode: MediaStreamAudioSourceNode | null;
};

export async function stopActiveMediaTracks(session: ActiveMediaSession | null): Promise<void> {
  if (!session) {
    return;
  }
  if (session.playbackSourceNode) {
    session.playbackSourceNode.disconnect();
    session.playbackSourceNode = null;
  }
  session.stream.getTracks().forEach((track) => {
    track.stop();
  });
  if (session.playbackAudioContext) {
    const context = session.playbackAudioContext;
    session.playbackAudioContext = null;
    await context.close().catch(() => {});
  }
}
