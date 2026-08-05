/**
 * Host permission helpers for Firefox full-record (and Instant Replay reuse).
 *
 * Firefox MV3 treats host_permissions as optional. Full-record needs them for
 * re-injection after navigation and for reliable evidence after the media host
 * tab steals focus (which revokes activeTab). The origins mirror
 * `optional_host_permissions` in the manifest.
 *
 * `permissions.request` requires a user gesture in the calling context. Prefer
 * the popup Start click (earliest viable gesture) over the media-tab grant step.
 * Never combine this request with the getDisplayMedia click — awaiting the
 * permission prompt consumes transient activation.
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
