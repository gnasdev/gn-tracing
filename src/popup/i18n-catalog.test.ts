import { describe, expect, it } from "vitest";
import { POPUP_TRANSLATIONS } from "./i18n-catalog";

describe("POPUP_TRANSLATIONS catalog", () => {
  it("has matching en/vi key sets", () => {
    const enKeys = Object.keys(POPUP_TRANSLATIONS.en).sort();
    const viKeys = Object.keys(POPUP_TRANSLATIONS.vi).sort();
    expect(viKeys).toEqual(enKeys);
    expect(enKeys.length).toBeGreaterThan(50);
  });

  it("includes core recording action strings", () => {
    expect(POPUP_TRANSLATIONS.en["actions.startRecording"]).toMatch(/Start/i);
    expect(POPUP_TRANSLATIONS.vi["actions.startRecording"]).toBeTruthy();
    expect(POPUP_TRANSLATIONS.en["actions.done"]).toBe("Done");
    expect(POPUP_TRANSLATIONS.vi["actions.done"]).toBe("Xong");
    expect(POPUP_TRANSLATIONS.en["recording.cdpBannerWarning"]).toContain("debugging this tab");
    expect(POPUP_TRANSLATIONS.vi["recording.cdpBannerWarning"]).toContain("Chrome");
  });

  it("includes actionable microphone access failures", () => {
    expect(POPUP_TRANSLATIONS.en["audioSettings.microphonePermissionDenied"]).toBeTruthy();
    expect(POPUP_TRANSLATIONS.en["audioSettings.microphoneUnavailable"]).toBeTruthy();
    expect(POPUP_TRANSLATIONS.en["audioSettings.microphoneBusy"]).toBeTruthy();
    expect(POPUP_TRANSLATIONS.en["audioSettings.deviceDiscoveryFailed"]).toBeTruthy();
    expect(POPUP_TRANSLATIONS.en["audioSettings.enableMicrophone"]).toBeTruthy();
    expect(POPUP_TRANSLATIONS.en["audioSettings.microphonePermissionRequired"]).toMatch(/browser/i);
    expect(POPUP_TRANSLATIONS.en["audioSettings.microphonePermissionGranted"]).toBeTruthy();
    expect(POPUP_TRANSLATIONS.en["audioSettings.inputs"]).toBeTruthy();
    expect(POPUP_TRANSLATIONS.en["audioSettings.microphoneHint"]).toBeTruthy();
    expect(POPUP_TRANSLATIONS.en["audioSettings.systemAudioOptional"]).toBeTruthy();
    expect(POPUP_TRANSLATIONS.en["audioSettings.saving"]).toBeTruthy();
    expect(POPUP_TRANSLATIONS.vi["audioSettings.microphonePermissionDenied"]).toBeTruthy();
    expect(POPUP_TRANSLATIONS.vi["audioSettings.microphoneUnavailable"]).toBeTruthy();
    expect(POPUP_TRANSLATIONS.vi["audioSettings.microphoneBusy"]).toBeTruthy();
    expect(POPUP_TRANSLATIONS.vi["audioSettings.deviceDiscoveryFailed"]).toBeTruthy();
    expect(POPUP_TRANSLATIONS.vi["audioSettings.enableMicrophone"]).toBeTruthy();
    expect(POPUP_TRANSLATIONS.vi["audioSettings.microphonePermissionRequired"]).toBeTruthy();
    expect(POPUP_TRANSLATIONS.vi["audioSettings.microphonePermissionGranted"]).toBeTruthy();
    expect(POPUP_TRANSLATIONS.vi["audioSettings.inputs"]).toBeTruthy();
    expect(POPUP_TRANSLATIONS.vi["audioSettings.microphoneHint"]).toBeTruthy();
    expect(POPUP_TRANSLATIONS.vi["audioSettings.systemAudioOptional"]).toBeTruthy();
    expect(POPUP_TRANSLATIONS.vi["audioSettings.saving"]).toBeTruthy();
  });

  it("localizes toast dismissal and the Instant Replay duration for assistive tech", () => {
    expect(POPUP_TRANSLATIONS.en["toast.dismiss"]).toBe("Dismiss notification");
    expect(POPUP_TRANSLATIONS.vi["toast.dismiss"]).toBe("Đóng thông báo");
    expect(POPUP_TRANSLATIONS.vi["instantReplay.windowValue"]).toBe("{seconds} giây");
    expect(POPUP_TRANSLATIONS.en["stats.network"]).toBe("Network");
    expect(POPUP_TRANSLATIONS.vi["stats.network"]).toBe("Mạng");
  });
});
