export const MICROPHONE_PERMISSION_RESULT_KEY = "gn_tracing_microphone_permission_result";

export type AudioInputPermissionFailure = "denied" | "unavailable" | "busy" | "unknown";

export type AudioDevice = {
  kind: string;
  deviceId: string;
  label: string;
};

export type MicrophonePermissionResult =
  | { ok: true; audioDevices: AudioDevice[] }
  | { ok: false; error: string; audioInputFailure: AudioInputPermissionFailure };

const AUDIO_INPUT_FAILURES = new Set<AudioInputPermissionFailure>([
  "denied",
  "unavailable",
  "busy",
  "unknown",
]);

export function classifyAudioInputPermissionFailure(error: unknown): AudioInputPermissionFailure {
  const name = error instanceof DOMException ? error.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "denied";
    case "NotFoundError":
      return "unavailable";
    case "NotReadableError":
      return "busy";
    default:
      return "unknown";
  }
}

export function parseMicrophonePermissionResult(value: unknown): MicrophonePermissionResult | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.ok === true) {
    if (!Array.isArray(candidate.audioDevices)) {
      return null;
    }
    const audioDevices: AudioDevice[] = [];
    for (const device of candidate.audioDevices) {
      if (!device || typeof device !== "object") {
        return null;
      }
      const item = device as Record<string, unknown>;
      if (
        typeof item.kind !== "string" ||
        typeof item.deviceId !== "string" ||
        typeof item.label !== "string"
      ) {
        return null;
      }
      audioDevices.push({ kind: item.kind, deviceId: item.deviceId, label: item.label });
    }
    return { ok: true, audioDevices };
  }
  if (
    candidate.ok === false &&
    typeof candidate.error === "string" &&
    typeof candidate.audioInputFailure === "string" &&
    AUDIO_INPUT_FAILURES.has(candidate.audioInputFailure as AudioInputPermissionFailure)
  ) {
    return {
      ok: false,
      error: candidate.error,
      audioInputFailure: candidate.audioInputFailure as AudioInputPermissionFailure,
    };
  }
  return null;
}
