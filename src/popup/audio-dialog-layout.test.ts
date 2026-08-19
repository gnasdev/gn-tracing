import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const popupHtml = readFileSync(resolve(__dirname, "../../popup/popup.html"), "utf8");
const popupSource = readFileSync(resolve(__dirname, "./popup.ts"), "utf8");
const popupCss = readFileSync(resolve(__dirname, "../../popup/popup.css"), "utf8");
const themeCss = readFileSync(resolve(__dirname, "../../shared/theme.css"), "utf8");

describe("popup audio device dialog layout", () => {
  it("shows the selected sources below recording with a labeled device trigger", () => {
    const recordingRow = popupHtml.indexOf(
      'class="recording-actions-row recording-actions-primary"',
    );
    const audioSummary = popupHtml.indexOf('id="audio-settings-summary"');
    const deviceButton = popupHtml.indexOf('id="audio-settings-btn"');
    const audioDialog = popupHtml.indexOf('id="audio-settings-dialog"');
    const microphoneControl = popupHtml.indexOf('id="microphone-device-id-input"');

    expect(recordingRow).toBeGreaterThanOrEqual(0);
    expect(audioSummary).toBeGreaterThan(recordingRow);
    expect(deviceButton).toBeGreaterThan(audioSummary);
    expect(audioDialog).toBeGreaterThan(deviceButton);
    expect(microphoneControl).toBeGreaterThan(audioDialog);
    expect(popupHtml).toContain('id="audio-settings-microphone-summary"');
    expect(popupHtml).toContain('id="audio-settings-speaker-summary"');
    expect(popupHtml).toContain('id="speaker-device-id-input"');
    expect(popupHtml).not.toContain('id="capture-speaker-audio-input"');
    expect(popupHtml).toContain('data-i18n="audioSummary.label"');
    expect(popupHtml).toContain('aria-controls="audio-settings-dialog"');
    expect(popupHtml).toContain('aria-labelledby="audio-settings-dialog-title"');
  });

  it("presents audio choices as a compact source console with clear device rows", () => {
    const audioDialog = popupHtml.slice(popupHtml.indexOf('id="audio-settings-dialog"'));

    expect(popupHtml).toContain('class="audio-source-console"');
    expect(popupHtml).toContain('class="audio-source-console-row"');
    expect(popupHtml).toContain('id="audio-settings-microphone-source"');
    expect(popupHtml).toContain('id="audio-settings-speaker-source"');
    expect(audioDialog).toContain('class="audio-source-picker"');
    expect(audioDialog).toMatch(
      /<section\s+id="audio-controls"\s+class="audio-source-picker"[^>]*\bhidden\b/,
    );
    expect(audioDialog).toContain('class="audio-source-field"');
    expect(audioDialog).toContain('id="audio-settings-save-status"');
    expect(audioDialog).toContain('data-i18n="audioSettings.systemAudioOptional"');
    expect(popupCss).toContain(".audio-source-console {");
    expect(popupCss).toContain(".audio-source-picker {");
    expect(popupSource).toContain(
      'audioSettingsSpeakerSource.classList.toggle("is-included", Boolean(selectedSpeakerDeviceId));',
    );
    expect(popupSource).toContain("audioSettingsSaveStatus.hidden = !audioSettingsSaveInFlight;");
    expect(popupSource).toContain("audioControls.hidden = !audioInputPermissionGranted;");
  });

  it("renders settings as flat sections with icon-only save actions", () => {
    const settingsDialog = popupHtml.slice(popupHtml.indexOf('id="settings-dialog"'));

    expect(settingsDialog).toContain('class="settings-section"');
    expect(settingsDialog).toContain('class="settings-section-save"');
    expect(settingsDialog).toContain('data-i18n-aria="actions.saveSection"');
    expect(settingsDialog).toContain('<i class="ph ph-floppy-disk" aria-hidden="true"></i>');
    expect(settingsDialog).not.toContain('data-i18n="actions.saveSection"');
  });

  it("renders theme as a labeled Settings section with explicit preferences", () => {
    const mainHeader = popupHtml.slice(
      popupHtml.indexOf("<header"),
      popupHtml.indexOf("</header>"),
    );
    const settingsDialog = popupHtml.slice(popupHtml.indexOf('id="settings-dialog"'));
    const themeSectionStart = settingsDialog.indexOf('data-settings-section="theme"');
    const privacySectionStart = settingsDialog.indexOf('data-settings-section="privacy"');
    const themeSection = settingsDialog.slice(themeSectionStart, privacySectionStart);

    expect(mainHeader).not.toContain('id="theme-toggle-btn"');
    expect(settingsDialog).not.toContain('id="theme-toggle-btn"');
    expect(themeSectionStart).toBeGreaterThanOrEqual(0);
    expect(themeSectionStart).toBeLessThan(privacySectionStart);
    expect(themeSection).toContain('data-i18n="theme.sectionTitle"');
    expect(themeSection).toContain('data-i18n="theme.description"');
    expect(themeSection).toContain('data-i18n="theme.preferenceLabel"');
    expect(themeSection).toContain('id="theme-system-input"');
    expect(themeSection).toContain('id="theme-light-input"');
    expect(themeSection).toContain('id="theme-dark-input"');
    expect(themeSection).toContain('data-i18n="theme.system"');
    expect(themeSection).toContain('data-i18n="theme.light"');
    expect(themeSection).toContain('data-i18n="theme.dark"');
  });

  it("keeps screenshot as an icon-only accessible action", () => {
    const screenshotButtonId = popupHtml.indexOf('id="screenshot-btn"');
    const screenshotButtonStart = popupHtml.lastIndexOf("<button", screenshotButtonId);
    const screenshotButtonEnd = popupHtml.indexOf("</button>", screenshotButtonStart);
    const screenshotButton = popupHtml.slice(screenshotButtonStart, screenshotButtonEnd);

    expect(screenshotButton).toContain('data-i18n-aria="actions.screenshotTitle"');
    expect(screenshotButton).toContain('<i class="ph ph-camera"');
    expect(screenshotButton).not.toContain('data-i18n="actions.screenshot"');
  });

  it("keeps Instant Replay settings as an icon-only accessible action", () => {
    const settingsButtonId = popupHtml.indexOf('id="instant-replay-settings-btn"');
    const settingsButtonStart = popupHtml.lastIndexOf("<button", settingsButtonId);
    const settingsButtonEnd = popupHtml.indexOf("</button>", settingsButtonStart);
    const settingsButton = popupHtml.slice(settingsButtonStart, settingsButtonEnd);

    expect(settingsButton).toContain('data-i18n-aria="instantReplay.settingsAria"');
    expect(settingsButton).toContain('<i class="ph ph-gear"');
    expect(settingsButton).not.toContain("instant-replay-settings-label");
  });

  it("keeps microphone and system source rows independently readable", () => {
    expect(popupHtml).toContain('id="audio-settings-microphone-source"');
    expect(popupHtml).toContain('id="audio-settings-speaker-source"');
    expect(popupHtml).toContain('class="audio-source-console-value"');
    expect(popupHtml).toContain('data-i18n="audioSummary.microphone"');
    expect(popupHtml).toContain('data-i18n="audioSummary.systemAudio"');
  });

  it("marks settings controls for compact custom rendering", () => {
    const settingsDialog = popupHtml.slice(popupHtml.indexOf('id="settings-dialog"'));

    expect(settingsDialog).toContain('class="settings-check settings-switch"');
    expect(settingsDialog).toContain('class="setting-field setting-field-inline"');
    expect(settingsDialog).toContain('for="redact-websocket-payloads-input"');
    expect(settingsDialog).toContain('for="mask-dom-selectors-input"');
  });

  it("explains network-coupled inspector controls before their switches", () => {
    const inspectorSection = popupHtml.slice(popupHtml.indexOf('data-i18n="sections.inspector"'));
    const couplingNote = inspectorSection.indexOf('class="settings-coupling-note"');
    const storageSwitch = inspectorSection.indexOf('id="capture-storage-input"');

    expect(inspectorSection).toContain('data-i18n="hints.inspectorCaptureCoupling"');
    expect(couplingNote).toBeGreaterThanOrEqual(0);
    expect(couplingNote).toBeLessThan(storageSwitch);
  });

  it("keeps microphone capture behind an explicit Devices-dialog grant action", () => {
    const initPopupStart = popupSource.indexOf("async function initPopup()");
    const initPopup = popupSource.slice(initPopupStart, initPopupStart + 3000);
    const audioDialog = popupHtml.slice(popupHtml.indexOf('id="audio-settings-dialog"'));
    const audioDialogRegistration = popupSource.slice(
      popupSource.indexOf('popupDialogEntries.set("audio"'),
      popupSource.indexOf('popupDialogEntries.set("settings"'),
    );
    const grantHandlerStart = popupSource.indexOf(
      'audioCapturePermissionBtn.addEventListener("click"',
    );
    const grantHandler = popupSource.slice(grantHandlerStart, grantHandlerStart + 400);
    const grantFunctionStart = popupSource.indexOf("async function grantMicrophoneAccess");
    const grantFunction = popupSource.slice(grantFunctionStart, grantFunctionStart + 1000);

    expect(initPopup).toContain("await refreshMicrophoneDevices();");
    expect(initPopup).not.toContain("requestAudioInputPermission");
    expect(audioDialog).toContain('id="audio-capture-permission-btn"');
    expect(audioDialog).toContain('id="audio-capture-permission-status"');
    expect(audioDialog).not.toContain("macos-microphone-permission-guidance");
    expect(audioDialog).not.toContain("macosPermissionGuidance");
    expect(audioDialog).toContain('data-i18n="audioSettings.enableMicrophone"');
    expect(audioDialogRegistration).toContain(
      "void refreshMicrophoneDevices({ showDiscoveryFailure: true });",
    );
    expect(grantHandlerStart).toBeGreaterThan(-1);
    expect(grantHandler).toContain("grantMicrophoneAccess()");
    expect(grantFunctionStart).toBeGreaterThan(-1);
    expect(grantFunction).toContain("resolveMicrophonePermissionPageUrl");
    expect(grantFunction).toContain("chrome.tabs.create");
    expect(grantFunction).not.toContain("REQUEST_MICROPHONE_PERMISSION");
    expect(grantFunction).not.toContain("navigator.mediaDevices.getUserMedia");
    expect(popupSource).not.toContain("macosMicrophonePermissionGuidance");
    expect(popupSource).not.toContain("parseOsFromUserAgent");
    expect(popupSource).not.toContain("chrome.permissions.request");
  });

  it("surfaces microphone permission and device discovery failures", () => {
    expect(popupSource).toContain('showToast(t("audioSettings.microphonePermissionDenied")');
    expect(popupSource).toContain('showToast(t("audioSettings.microphoneUnavailable")');
    expect(popupSource).toContain('showToast(t("audioSettings.microphoneBusy")');
    expect(popupSource).toContain('showToast(t("audioSettings.deviceDiscoveryFailed")');
  });

  it("uses a success Done action and an icon-only accessible discard action", () => {
    const discardButtonId = popupHtml.indexOf('id="remove-recording-btn"');
    const discardButtonStart = popupHtml.lastIndexOf("<button", discardButtonId);
    const discardButtonEnd = popupHtml.indexOf("</button>", discardButtonStart);
    const discardButton = popupHtml.slice(discardButtonStart, discardButtonEnd);

    expect(discardButton).toContain('data-i18n-aria="actions.discard"');
    expect(discardButton).toContain('data-i18n-title="actions.discard"');
    expect(discardButton).toContain('<i class="ph ph-trash"');
    expect(discardButton).not.toContain('data-i18n="actions.discard"');
    expect(popupSource).toContain('t("actions.done")');
    expect(popupSource).toContain('toggleBtn.className = "btn btn-success"');
    expect(popupSource).toContain("Icons.check()");
    expect(themeCss).toContain(".btn-success {");
    expect(popupCss).toMatch(
      /#remove-recording-btn \{[\s\S]*?width: 42px;[\s\S]*?padding-inline: 0;/,
    );
  });

  it("captures selected audio device IDs before re-rendering the busy controls", () => {
    const saveStart = popupSource.indexOf("async function saveAudioSettings()");
    const saveEnd = popupSource.indexOf("function registerPopupDialogs", saveStart);
    const saveFunction = popupSource.slice(saveStart, saveEnd);
    const payloadSnapshot = saveFunction.indexOf(
      "const audioSettingsUpdate = buildAudioSettingsUpdate(",
    );
    const busyRender = saveFunction.indexOf("renderAudioControls();");

    expect(saveStart).toBeGreaterThanOrEqual(0);
    expect(payloadSnapshot).toBeGreaterThanOrEqual(0);
    expect(payloadSnapshot).toBeLessThan(busyRender);
    expect(saveFunction).toContain("data: audioSettingsUpdate");
  });
});
