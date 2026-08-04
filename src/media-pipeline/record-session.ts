/**
 * MediaRecorder session helpers shared by the offscreen/media document.
 *
 * Keeps stream acquisition + recorder lifecycle out of the packaging entry so
 * that file stays under the size budget while message contracts stay stable.
 */

export type SessionRecordingSnapshot = {
  blob: Blob;
  mimeType: string;
  createdAt: number;
};

export type CaptureStreamResult = {
  stream: MediaStream;
  loopbackTabAudio: boolean;
};

export async function acquireCaptureStream(
  streamId: string,
  mode: string,
): Promise<CaptureStreamResult> {
  if (mode === "display-media" || !streamId) {
    // Firefox (and any host without tabCapture): user-facing picker.
    // preferCurrentTab is a Chromium hint; other engines ignore unknown keys.
    const displayConstraints = {
      video: {
        preferCurrentTab: true,
        width: { ideal: 1920, max: 1920 },
        height: { ideal: 1080, max: 1080 },
        frameRate: { ideal: 30, max: 30 },
      },
      audio: true,
    } as DisplayMediaStreamOptions;
    const stream = await navigator.mediaDevices.getDisplayMedia(displayConstraints);
    return { stream, loopbackTabAudio: false };
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    } as MediaTrackConstraints,
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
  return { stream, loopbackTabAudio: true };
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

export function pickRecorderMimeType(): string {
  return MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")
    ? "video/webm;codecs=vp9,opus"
    : "video/webm;codecs=vp8,opus";
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
