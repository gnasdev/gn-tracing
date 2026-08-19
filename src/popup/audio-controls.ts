export interface MicrophoneDeviceLike {
  kind: string;
  deviceId: string;
  label: string;
}

export interface MicrophoneOption {
  value: string;
  label: string;
  unavailable?: boolean;
}

export interface MicrophoneOptionLabels {
  browserDefault: string;
  microphone: string;
  unavailable: string;
}

export function buildMicrophoneOptions(
  devices: readonly MicrophoneDeviceLike[],
  selectedDeviceId: string,
  labels: MicrophoneOptionLabels,
): MicrophoneOption[] {
  const microphones = devices.filter((device) => device.kind === "audioinput" && device.deviceId);
  const options: MicrophoneOption[] = [
    { value: "", label: labels.browserDefault },
    ...microphones.map((device, index) => ({
      value: device.deviceId,
      label: device.label || `${labels.microphone} ${index + 1}`,
    })),
  ];

  if (selectedDeviceId && !microphones.some((device) => device.deviceId === selectedDeviceId)) {
    options.push({
      value: selectedDeviceId,
      label: `${labels.microphone} (${labels.unavailable})`,
      unavailable: true,
    });
  }

  return options;
}

export function buildAudioSettingsUpdate(
  microphoneDeviceId: string,
  speakerDeviceId: string,
): { microphoneDeviceId: string; speakerDeviceId: string } {
  return {
    microphoneDeviceId: microphoneDeviceId.trim(),
    speakerDeviceId: speakerDeviceId.trim(),
  };
}
