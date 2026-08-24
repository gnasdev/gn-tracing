import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const popupHtml = readFileSync(resolve(__dirname, "../../popup/popup.html"), "utf8");
const popupSource = readFileSync(resolve(__dirname, "./popup.ts"), "utf8");
const popupCss = readFileSync(resolve(__dirname, "../../popup/popup.css"), "utf8");
const themeCss = readFileSync(resolve(__dirname, "../../shared/theme.css"), "utf8");

describe("popup inline audio controls layout", () => {
  it("shows editable audio controls below recording and before Instant Replay", () => {
    const recordingRow = popupHtml.indexOf(
      'class="recording-actions-row recording-actions-primary"',
    );
    const audioSettings = popupHtml.indexOf('id="audio-settings"');
    const microphoneControl = popupHtml.indexOf('id="microphone-device-id-input"');
    const instantReplayControls = popupHtml.indexOf('id="instant-replay-controls"');

    expect(recordingRow).toBeGreaterThanOrEqual(0);
    expect(audioSettings).toBeGreaterThan(recordingRow);
    expect(microphoneControl).toBeGreaterThan(audioSettings);
    expect(instantReplayControls).toBeGreaterThan(microphoneControl);
    expect(popupHtml).not.toContain('id="speaker-device-id-input"');
    expect(popupHtml).not.toContain('id="capture-speaker-audio-input"');
    expect(popupHtml).not.toContain('id="audio-settings-dialog"');
    expect(popupHtml).not.toContain('id="audio-settings-btn"');
    expect(popupHtml).toContain('data-i18n="audioSummary.label"');
  });

  it("presents audio choices as an inline console with clear device fields", () => {
    const audioSettingsStart = popupHtml.indexOf('id="audio-settings"');
    const audioSettings = popupHtml.slice(audioSettingsStart, audioSettingsStart + 5000);

    expect(audioSettings).toContain('class="audio-settings-inline"');
    expect(audioSettings).toContain('class="audio-source-picker"');
    expect(audioSettings).toMatch(
      /<section\s+id="audio-controls"\s+class="audio-source-picker"(?![^>]*\bhidden\b)/,
    );
    expect(audioSettings).toContain('id="microphone-enabled-toggle"');
    expect(audioSettings).toContain('aria-pressed="true"');
    expect(audioSettings).toContain('class="audio-source-field"');
    expect(audioSettings).not.toContain('id="audio-settings-save-status"');
    expect(popupCss).toContain(".audio-settings-inline {");
    expect(popupCss).toContain(".audio-source-picker {");
    expect(popupSource).toContain("audioSettingsSection.hidden = true;");
    expect(popupSource).not.toContain("audioSettingsSaveStatus");
    expect(popupSource).toContain(
      "microphoneDeviceIdInput.disabled = disabled || !microphoneEnabled;",
    );
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

  it("keeps the microphone field readable", () => {
    expect(popupHtml).toContain('for="microphone-device-id-input"');
    expect(popupHtml).toContain('data-i18n="fields.microphoneDeviceId.label"');
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

  it("persists the inline microphone toggle before opening its permission page", () => {
    const initPopupStart = popupSource.indexOf("async function initPopup()");
    const initPopup = popupSource.slice(initPopupStart, initPopupStart + 3000);
    const audioSettingsStart = popupHtml.indexOf('id="audio-settings"');
    const audioSettings = popupHtml.slice(audioSettingsStart, audioSettingsStart + 5000);
    const toggleHandlerStart = popupSource.indexOf(
      'microphoneEnabledToggle.addEventListener("click"',
    );
    const toggleHandler = popupSource.slice(toggleHandlerStart, toggleHandlerStart + 200);
    const toggleFunctionStart = popupSource.indexOf("async function toggleMicrophoneRecording");
    const toggleFunction = popupSource.slice(toggleFunctionStart, toggleFunctionStart + 600);
    const permissionFunctionStart = popupSource.indexOf(
      "async function openMicrophonePermissionPage",
    );
    const permissionFunction = popupSource.slice(
      permissionFunctionStart,
      permissionFunctionStart + 600,
    );

    expect(initPopup).toContain("await refreshMicrophoneDevices({ showDiscoveryFailure: true });");
    expect(initPopup).not.toContain("requestAudioInputPermission");
    expect(audioSettings).toContain('id="microphone-enabled-toggle"');
    expect(audioSettings).toContain('aria-pressed="true"');
    expect(popupHtml).not.toContain('id="audio-settings-dialog"');
    expect(popupSource).not.toContain('popupDialogEntries.set("audio"');
    expect(popupSource).not.toContain("setAudioSettingsOpen");
    expect(toggleHandlerStart).toBeGreaterThan(-1);
    expect(toggleHandler).toContain("toggleMicrophoneRecording()");
    expect(toggleFunctionStart).toBeGreaterThan(-1);
    expect(toggleFunction).toContain("await saveAudioSettings(microphoneEnabled)");
    expect(toggleFunction).toContain(
      "if (microphoneEnabled && !(await hasMicrophonePermission()))",
    );
    expect(toggleFunction).toContain("await openMicrophonePermissionPage()");
    expect(permissionFunctionStart).toBeGreaterThan(-1);
    expect(permissionFunction).toContain("resolveMicrophonePermissionPageUrl");
    expect(permissionFunction).toContain("chrome.tabs.create");
    expect(permissionFunction).toContain('t("audioSettings.permissionPageOpenFailed")');
    expect(permissionFunction).not.toContain("REQUEST_MICROPHONE_PERMISSION");
    expect(permissionFunction).not.toContain("navigator.mediaDevices.getUserMedia");
    expect(popupSource).not.toContain("audioCapturePermissionBtn");
    expect(popupSource).not.toContain("macosMicrophonePermissionGuidance");
    expect(popupSource).not.toContain("parseOsFromUserAgent");
    expect(popupSource).not.toContain("chrome.permissions.request");
  });

  it("surfaces microphone device discovery failures", () => {
    expect(popupSource).toContain('showToast(t("audioSettings.deviceDiscoveryFailed")');
  });

  it("uses a primary Done action and an icon-only accessible discard action", () => {
    const discardButtonId = popupHtml.indexOf('id="remove-recording-btn"');
    const discardButtonStart = popupHtml.lastIndexOf("<button", discardButtonId);
    const discardButtonEnd = popupHtml.indexOf("</button>", discardButtonStart);
    const discardButton = popupHtml.slice(discardButtonStart, discardButtonEnd);

    expect(discardButton).toContain('data-i18n-aria="actions.discard"');
    expect(discardButton).toContain('data-i18n-title="actions.discard"');
    expect(discardButton).toContain('<i class="ph ph-trash"');
    expect(discardButton).not.toContain('data-i18n="actions.discard"');
    expect(popupSource).toContain('t("actions.done")');
    expect(popupSource).toContain('toggleBtn.className = "btn btn-start"');
    expect(popupSource).toContain("Icons.check()");
    expect(themeCss).toContain(".btn-start {");
    expect(popupCss).toMatch(
      /#remove-recording-btn \{[\s\S]*?width: 42px;[\s\S]*?padding-inline: 0;/,
    );
  });

  it("captures selected audio device IDs before re-rendering the busy controls", () => {
    const saveStart = popupSource.indexOf("async function saveAudioSettings(");
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
