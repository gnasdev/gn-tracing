/**
 * Single source of truth for Firefox full-record arm-panel action copy.
 *
 * The arm button in `offscreen/offscreen.html` must show this exact label.
 * Timeout and InvalidStateError messages name the same string so the user is
 * never told to press a button that does not exist (historical "Share this tab").
 */

/** Label on `#arm-btn` — keep in sync with offscreen/offscreen.html. */
export const FIREFOX_ARM_BUTTON_LABEL = "Choose what to share";

/** Background arm-window timeout after the user never presses the arm button. */
export function describeFirefoxArmTimeoutMessage(): string {
  return (
    "Timed out waiting for screen sharing to be allowed. " +
    `Start the recording again and press ${FIREFOX_ARM_BUTTON_LABEL}.`
  );
}

/** getDisplayMedia InvalidStateError (lost transient activation). */
export function describeFirefoxArmInvalidStateMessage(): string {
  return (
    "The browser refused screen sharing because it was not requested from a click. " +
    `Open the GN Tracing capture window and press ${FIREFOX_ARM_BUTTON_LABEL}.`
  );
}
