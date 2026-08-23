import { describe, expect, it, vi } from "vitest";
import {
  acquireMicrophoneStream,
  buildMicrophoneConstraints,
  mixCaptureAudio,
} from "./audio-capture";

type FakeStream = {
  getVideoTracks: () => MediaStreamTrack[];
  getAudioTracks: () => MediaStreamTrack[];
  getTracks: () => MediaStreamTrack[];
};

function stream(
  videoTracks: MediaStreamTrack[] = [],
  audioTracks: MediaStreamTrack[] = [],
): FakeStream {
  return {
    getVideoTracks: () => videoTracks,
    getAudioTracks: () => audioTracks,
    getTracks: () => [...videoTracks, ...audioTracks],
  };
}

describe("buildMicrophoneConstraints", () => {
  it("uses the browser default when no microphone is selected", () => {
    expect(buildMicrophoneConstraints("")).toEqual({ audio: true });
  });

  it("pins microphone capture to the selected input device", () => {
    expect(buildMicrophoneConstraints("mic-2")).toEqual({
      audio: { deviceId: { exact: "mic-2" } },
    });
  });
});

describe("acquireMicrophoneStream", () => {
  it("skips getUserMedia when microphone recording is disabled", async () => {
    const getUserMedia = vi.fn();

    await expect(acquireMicrophoneStream("mic-2", false, getUserMedia)).resolves.toBeNull();
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("falls back to the browser default when the selected device is unavailable", async () => {
    const microphone = stream([], [{ kind: "audio" } as MediaStreamTrack]);
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("gone", "NotFoundError") as never)
      .mockResolvedValueOnce(microphone as unknown as MediaStream);

    const result = await acquireMicrophoneStream("mic-gone", true, getUserMedia);

    expect(result).toBe(microphone);
    expect(getUserMedia).toHaveBeenNthCalledWith(1, {
      audio: { deviceId: { exact: "mic-gone" } },
    });
    expect(getUserMedia).toHaveBeenNthCalledWith(2, { audio: true });
  });

  it("returns no stream when the browser default microphone is unavailable", async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new Error("denied"));

    await expect(acquireMicrophoneStream("", true, getUserMedia)).resolves.toBeNull();
    expect(getUserMedia).toHaveBeenCalledOnce();
  });
});

describe("mixCaptureAudio", () => {
  it("keeps video and combines tab and microphone audio tracks", async () => {
    const video = { kind: "video" } as MediaStreamTrack;
    const tabAudio = { kind: "audio", label: "Tab audio" } as MediaStreamTrack;
    const microphone = { kind: "audio", label: "Mic" } as MediaStreamTrack;
    const mixed = { kind: "audio", label: "Mixed audio" } as MediaStreamTrack;
    const sources: Array<{
      connect: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
    }> = [];
    const destination = {
      stream: stream([], [mixed]),
    };
    const context = {
      createMediaStreamSource: vi.fn(() => {
        const source = { connect: vi.fn(), disconnect: vi.fn() };
        sources.push(source);
        return source;
      }),
      createMediaStreamDestination: vi.fn(() => destination),
      destination: {},
      close: vi.fn(async () => {}),
    };
    const outputStream = stream([video], [tabAudio]);

    const result = mixCaptureAudio(
      outputStream as unknown as MediaStream,
      [outputStream as unknown as MediaStream, stream([], [microphone]) as unknown as MediaStream],
      {
        createAudioContext: () => context as unknown as AudioContext,
        createMediaStream: (tracks) =>
          stream(
            tracks.filter((track) => track.kind === "video"),
            tracks.filter((track) => track.kind === "audio"),
          ) as unknown as MediaStream,
      },
    );

    expect(result.stream.getVideoTracks()).toEqual([video]);
    expect(result.stream.getAudioTracks()).toEqual([mixed]);
    expect(context.createMediaStreamSource).toHaveBeenCalledTimes(2);
    expect(sources.every((source) => source.connect.mock.calls.length > 0)).toBe(true);

    await result.cleanup();
    expect(sources.every((source) => source.disconnect.mock.calls.length === 1)).toBe(true);
    expect(context.close).toHaveBeenCalledOnce();
  });
});
