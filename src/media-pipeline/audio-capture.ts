export type AudioCaptureContext = Pick<
  AudioContext,
  "createMediaStreamSource" | "createMediaStreamDestination" | "close"
> & {
  readonly destination: AudioNode;
};

export type AudioCaptureDependencies = {
  createAudioContext: () => AudioCaptureContext;
  createMediaStream: (tracks: MediaStreamTrack[]) => MediaStream;
};

export type MixedCaptureAudio = {
  stream: MediaStream;
  audioContext: AudioCaptureContext | null;
  cleanup: () => Promise<void>;
};

export function buildMicrophoneConstraints(microphoneDeviceId: string): MediaStreamConstraints {
  const normalized = microphoneDeviceId.trim();
  return normalized ? { audio: { deviceId: { exact: normalized } } } : { audio: true };
}

export async function acquireMicrophoneStream(
  microphoneDeviceId: string,
  microphoneEnabled = true,
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream> = (constraints) =>
    navigator.mediaDevices.getUserMedia(constraints),
): Promise<MediaStream | null> {
  if (!microphoneEnabled) {
    return null;
  }

  const selectedConstraints = buildMicrophoneConstraints(microphoneDeviceId);
  try {
    return await getUserMedia(selectedConstraints);
  } catch (error) {
    if (!microphoneDeviceId.trim()) {
      console.warn("[GN Tracing] Microphone capture unavailable:", error);
      return null;
    }

    try {
      console.warn(
        "[GN Tracing] Selected microphone unavailable; falling back to the browser default:",
        error,
      );
      return await getUserMedia({ audio: true });
    } catch (fallbackError) {
      console.warn("[GN Tracing] Default microphone capture unavailable:", fallbackError);
      return null;
    }
  }
}

const defaultDependencies: AudioCaptureDependencies = {
  createAudioContext: () => new AudioContext(),
  createMediaStream: (tracks) => new MediaStream(tracks),
};

/**
 * Build the stream that MediaRecorder consumes. Audio sources are mixed only
 * when there is more than one audio track; a single track stays untouched.
 */
export function mixCaptureAudio(
  videoStream: MediaStream,
  audioStreams: MediaStream[],
  dependencies: Partial<AudioCaptureDependencies> = {},
): MixedCaptureAudio {
  const deps = { ...defaultDependencies, ...dependencies };
  const videoTracks = videoStream.getVideoTracks();
  const audioInputs = audioStreams.filter((candidate) => candidate.getAudioTracks().length > 0);
  const audioTracks = audioInputs.flatMap((candidate) => candidate.getAudioTracks());
  const baseTracks = [...videoTracks];

  if (audioTracks.length <= 1) {
    return {
      stream: deps.createMediaStream([...baseTracks, ...audioTracks]),
      audioContext: null,
      cleanup: async () => {},
    };
  }

  const audioContext = deps.createAudioContext();
  const destination = audioContext.createMediaStreamDestination();
  const sourceNodes = audioInputs.map((input) => audioContext.createMediaStreamSource(input));
  sourceNodes.forEach((source) => {
    source.connect(destination);
  });

  const mixedTrack = destination.stream.getAudioTracks()[0];
  if (!mixedTrack) {
    void audioContext.close();
    throw new Error("Could not create a mixed recording audio track.");
  }

  return {
    stream: deps.createMediaStream([...baseTracks, mixedTrack]),
    audioContext,
    cleanup: async () => {
      sourceNodes.forEach((source) => {
        source.disconnect();
      });
      await audioContext.close();
    },
  };
}
