/**
 * Firefox recording pipeline regressions.
 *
 * Covers three things measured on Firefox 153: how getDisplayMedia rejections are
 * turned into actionable text, why an audio codec must not be declared for a
 * video-only stream, and the stop/flush ordering that protects the blob.
 */

import { describe, expect, it, vi } from "vitest";
import {
  describeDisplayCaptureError,
  pickRecorderMimeType,
  stopRecorderAndWaitForFlush,
} from "./record-session";

describe("describeDisplayCaptureError", () => {
  it("treats a dismissed share picker as a cancellation, not an error", () => {
    for (const name of ["NotAllowedError", "AbortError"]) {
      const result = describeDisplayCaptureError(new DOMException("denied", name));
      expect(result.cancelled).toBe(true);
      expect(result.message).toContain("cancelled");
    }
  });

  it("replaces the transient-activation message with the actual next step", () => {
    const result = describeDisplayCaptureError(
      new DOMException(
        "getDisplayMedia requires transient activation from a user gesture.",
        "InvalidStateError",
      ),
    );
    expect(result.cancelled).toBe(false);
    // Must name the arm panel's button verbatim (offscreen/offscreen.html #arm-btn).
    expect(result.message).toContain("Choose what to share");
    // The raw wording must not reach the user.
    expect(result.message).not.toContain("transient activation");
  });

  it("points at the OS permission when the system blocks capture", () => {
    const result = describeDisplayCaptureError(new DOMException("busy", "NotReadableError"));
    expect(result.cancelled).toBe(false);
    expect(result.message).toContain("Screen Recording");
  });

  it("maps the remaining known DOMException names without cancelling", () => {
    for (const name of ["NotFoundError", "OverconstrainedError", "TypeError", "SecurityError"]) {
      const result = describeDisplayCaptureError(new DOMException("nope", name));
      expect(result.cancelled).toBe(false);
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  it("keeps unknown error text instead of hiding it", () => {
    const result = describeDisplayCaptureError(new Error("codec exploded"));
    expect(result.cancelled).toBe(false);
    expect(result.message).toContain("codec exploded");
  });

  it("survives non-Error rejections", () => {
    const result = describeDisplayCaptureError(undefined);
    expect(result.cancelled).toBe(false);
    expect(result.message).toBe("Could not start screen capture.");
  });
});

/**
 * The lost-recording bug on Firefox: `video/webm;codecs=vp8,opus` on a stream with
 * no audio track reports isTypeSupported=true, then never emits a chunk and never
 * fires `stop`. Firefox getDisplayMedia hands back video only, so the audio-bearing
 * codec string must never be used for it.
 */
describe("pickRecorderMimeType", () => {
  const videoOnly = { getAudioTracks: () => [] } as unknown as MediaStream;
  const withAudio = {
    getAudioTracks: () => [{} as MediaStreamTrack],
  } as unknown as MediaStream;

  /** Firefox 153: no vp9 at all, vp8+opus "supported" but broken without audio. */
  const firefox153 = (type: string) =>
    type === "video/webm;codecs=vp8,opus" ||
    type === "video/webm;codecs=vp8" ||
    type === "video/webm";

  it("never declares an audio codec for a video-only stream", () => {
    expect(pickRecorderMimeType(videoOnly, firefox153)).toBe("video/webm;codecs=vp8");
  });

  it("keeps the audio codec when the stream really has audio", () => {
    expect(pickRecorderMimeType(withAudio, firefox153)).toBe("video/webm;codecs=vp8,opus");
  });

  it("prefers vp9 where it is supported", () => {
    const all = () => true;
    expect(pickRecorderMimeType(videoOnly, all)).toBe("video/webm;codecs=vp9");
    expect(pickRecorderMimeType(withAudio, all)).toBe("video/webm;codecs=vp9,opus");
  });

  it("falls back to plain webm, then to the browser default", () => {
    const webmOnly = (type: string) => type === "video/webm";
    expect(pickRecorderMimeType(videoOnly, webmOnly)).toBe("video/webm");
    // Nothing supported: an empty string lets MediaRecorder choose.
    expect(pickRecorderMimeType(videoOnly, () => false)).toBe("");
  });

  it("assumes audio when no stream is supplied (Chromium tab capture)", () => {
    expect(pickRecorderMimeType(undefined, firefox153)).toBe("video/webm;codecs=vp8,opus");
  });
});

/**
 * The zero-byte-recording bug: tracks were stopped in the same task as
 * recorder.stop(), so Firefox threw away the final buffer and upload failed with
 * "snapshot no longer available". The caller must not release the stream until
 * this resolves flushed.
 */
describe("stopRecorderAndWaitForFlush", () => {
  function fakeRecorder() {
    return {
      state: "recording",
      requestData: vi.fn(),
      stop: vi.fn(),
    };
  }

  it("requests the pending data and stops the recorder", async () => {
    const recorder = fakeRecorder();
    await stopRecorderAndWaitForFlush(recorder, Promise.resolve(), 5000);
    expect(recorder.requestData).toHaveBeenCalledTimes(1);
    expect(recorder.stop).toHaveBeenCalledTimes(1);
  });

  it("waits for the stop handler rather than returning immediately", async () => {
    const recorder = fakeRecorder();
    let resolveFlush: () => void = () => {};
    const flush = new Promise<void>((resolve) => {
      resolveFlush = resolve;
    });

    let settled = false;
    const pending = stopRecorderAndWaitForFlush(recorder, flush, 5000).then((result) => {
      settled = true;
      return result;
    });

    await Promise.resolve();
    // Still waiting — this gap is exactly where the stream used to be killed.
    expect(settled).toBe(false);

    resolveFlush();
    await expect(pending).resolves.toEqual({ flushed: true });
  });

  it("reports flushed: false when the stop event never arrives", async () => {
    vi.useFakeTimers();
    try {
      const recorder = fakeRecorder();
      const pending = stopRecorderAndWaitForFlush(recorder, new Promise<void>(() => {}), 5000);
      await vi.advanceTimersByTimeAsync(5000);
      await expect(pending).resolves.toEqual({ flushed: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("still waits for the flush when stop() throws", async () => {
    const recorder = fakeRecorder();
    recorder.stop.mockImplementation(() => {
      throw new DOMException("already inactive", "InvalidStateError");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await expect(stopRecorderAndWaitForFlush(recorder, Promise.resolve(), 5000)).resolves.toEqual(
        { flushed: true },
      );
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
