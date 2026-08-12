/**
 * Host permission helpers for Firefox full-record (and Instant Replay reuse).
 *
 * Firefox MV3 treats host_permissions as optional. Full-record needs them for
 * re-injection after navigation and for reliable evidence after focus moves
 * away from the recorded tab. The origins mirror `optional_host_permissions`
 * in the manifest.
 *
 * `permissions.request` requires a user gesture in the calling context on
 * Firefox, and the gesture dies at the first `await` in that turn. So
 * {@link ensureRecordingHostPermission} calls `request()` immediately — it does
 * **not** `await contains()` first. When access is already held, browsers
 * resolve `request()` to `true` with no prompt, which is the "skip if granted"
 * behaviour product needs.
 *
 * Prefer the popup Start / Instant Replay enable click. The media-page grant
 * button is only a fallback when the user declined earlier or the gesture was
 * lost.
 *
 * Never combine this request with an in-flight getDisplayMedia call — not even
 * fire-and-forget in parallel. The permission prompt steals focus and Firefox
 * rejects the share picker with NotAllowedError ("Screen sharing was cancelled").
 */

export const RECORDING_HOST_ORIGINS = ["http://*/*", "https://*/*"] as const;

export async function hasRecordingHostPermission(
  origins: readonly string[] = RECORDING_HOST_ORIGINS,
): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: [...origins] });
  } catch {
    // Engine without optional host permissions (Chromium grants them at install).
    return true;
  }
}

/**
 * Prompt for recording host permission. Returns true when granted.
 * Call only from a user-gesture context (popup click or arm-panel grant button).
 *
 * Safe to call when already granted: resolves `true` with no prompt.
 */
export async function requestRecordingHostPermission(
  origins: readonly string[] = RECORDING_HOST_ORIGINS,
): Promise<boolean> {
  try {
    return await chrome.permissions.request({ origins: [...origins] });
  } catch {
    return false;
  }
}

/**
 * Ensure host permission is held, prompting only when missing.
 *
 * Invokes `permissions.request` in the same turn (no prior `await`), so a
 * Firefox popup click still counts as a user gesture. Already-granted access
 * does not show a dialog.
 *
 * Call from a popup (or other extension-page) user gesture so the prompt is
 * tied to the active browser window — not a newly opened grant-only tab.
 * Returns true when already granted or the user accepts.
 */
export async function ensureRecordingHostPermission(
  origins: readonly string[] = RECORDING_HOST_ORIGINS,
): Promise<boolean> {
  return requestRecordingHostPermission(origins);
}
