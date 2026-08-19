import { describe, expect, it } from "vitest";
import { parseMicrophonePermissionResult } from "../shared/microphone-permission";

describe("parseMicrophonePermissionResult", () => {
  it("keeps a successful probe's audio devices", () => {
    expect(
      parseMicrophonePermissionResult({
        ok: true,
        audioDevices: [{ kind: "audioinput", deviceId: "mic-1", label: "Desk mic" }],
      }),
    ).toEqual({
      ok: true,
      audioDevices: [{ kind: "audioinput", deviceId: "mic-1", label: "Desk mic" }],
    });
  });

  it("keeps an expected normalized failure but rejects malformed payloads", () => {
    expect(
      parseMicrophonePermissionResult({
        ok: false,
        error: "Permission dismissed",
        audioInputFailure: "denied",
      }),
    ).toEqual({
      ok: false,
      error: "Permission dismissed",
      audioInputFailure: "denied",
    });
    expect(parseMicrophonePermissionResult({ ok: true, audioDevices: "not an array" })).toBeNull();
    expect(parseMicrophonePermissionResult({ ok: false, audioInputFailure: "other" })).toBeNull();
  });
});
