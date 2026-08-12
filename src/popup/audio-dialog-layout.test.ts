import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const popupHtml = readFileSync(resolve(__dirname, "../../popup/popup.html"), "utf8");

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

  it("keeps microphone and system source summaries independently readable", () => {
    expect(popupHtml).toContain('class="audio-settings-summary-source"');
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
});
