import { describe, expect, it } from "vitest";
import { buildAudioSettingsUpdate, buildMicrophoneOptions } from "./audio-controls";

describe("buildMicrophoneOptions", () => {
  it("lists audio inputs after the browser default option", () => {
    expect(
      buildMicrophoneOptions(
        [
          { kind: "audioinput", deviceId: "mic-1", label: "Desk mic" },
          { kind: "videoinput", deviceId: "camera-1", label: "Camera" },
          { kind: "audioinput", deviceId: "mic-2", label: "USB mic" },
        ],
        "",
        {
          browserDefault: "Browser default",
          microphone: "Microphone",
          unavailable: "unavailable",
        },
      ),
    ).toEqual([
      { value: "", label: "Browser default" },
      { value: "mic-1", label: "Desk mic" },
      { value: "mic-2", label: "USB mic" },
    ]);
  });

  it("preserves a saved microphone as unavailable when it is not enumerated", () => {
    expect(
      buildMicrophoneOptions(
        [{ kind: "audioinput", deviceId: "mic-1", label: "Desk mic" }],
        "mic-gone",
        {
          browserDefault: "Browser default",
          microphone: "Microphone",
          unavailable: "unavailable",
        },
      ),
    ).toEqual([
      { value: "", label: "Browser default" },
      { value: "mic-1", label: "Desk mic" },
      {
        value: "mic-gone",
        label: "Microphone (unavailable)",
        unavailable: true,
      },
    ]);
  });
});

describe("buildAudioSettingsUpdate", () => {
  it("creates the partial settings payload for the selected microphone", () => {
    expect(buildAudioSettingsUpdate(false, "mic-2")).toEqual({
      microphoneEnabled: false,
      microphoneDeviceId: "mic-2",
    });
  });
});
