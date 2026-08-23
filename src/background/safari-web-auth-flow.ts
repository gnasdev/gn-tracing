/**
 * Drop-in replacement for `chrome.identity.launchWebAuthFlow` on Safari,
 * which has no `identity` API at all (see oauth-redirect-policy.ts header).
 *
 * Opens the OAuth consent URL in a new tab and watches `tabs.onUpdated` for
 * navigation to `SAFARI_OAUTH_CALLBACK_URL` (a real, first-party-owned page —
 * see that constant's doc comment). The listener fires as soon as the tab's
 * URL changes, before the callback page's content has to load or do
 * anything, so no server-side route or relay page is required for the happy
 * path. Same signature contract as `chrome.identity.launchWebAuthFlow`:
 * resolves with the final URL (including the query string with `code`/
 * `state`), or rejects if the user closes the tab first.
 *
 * Callers (dropbox-auth.ts, google-drive-auth.ts) should use the exported
 * {@link launchWebAuthFlow} dispatcher rather than branching on the browser
 * target themselves or calling `launchSafariWebAuthFlow` directly.
 */

import { getBrowserTarget } from "../platform/detect";
import { SAFARI_OAUTH_CALLBACK_URL } from "../shared/oauth-redirect-policy";

/** How long to wait for the provider redirect before giving up. */
const AUTH_FLOW_TIMEOUT_MS = 5 * 60 * 1000;

export async function launchSafariWebAuthFlow(options: { url: string }): Promise<string> {
  const tab = await chrome.tabs.create({ url: options.url });
  if (!tab?.id) {
    throw new Error("Could not open the sign-in tab.");
  }
  const tabId = tab.id;

  return new Promise((resolve, reject) => {
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    };

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const onUpdated = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId !== tabId || !changeInfo.url) return;
      if (!changeInfo.url.startsWith(SAFARI_OAUTH_CALLBACK_URL)) return;
      const finalUrl = changeInfo.url;
      settle(() => {
        chrome.tabs.remove(tabId).catch(() => {});
        resolve(finalUrl);
      });
    };

    const onRemoved = (removedTabId: number) => {
      if (removedTabId !== tabId) return;
      settle(() => reject(new Error("Sign-in was cancelled (the tab was closed).")));
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    timeoutHandle = setTimeout(() => {
      settle(() => {
        chrome.tabs.remove(tabId).catch(() => {});
        reject(new Error("Sign-in timed out."));
      });
    }, AUTH_FLOW_TIMEOUT_MS);
  });
}

/**
 * Platform-dispatching entry point: callers should use this instead of
 * branching on the browser target themselves. Safari (macOS + iOS) has no
 * `identity` API at all, so it always takes the tabs-based path; every other
 * target uses the real `chrome.identity.launchWebAuthFlow`.
 */
export function launchWebAuthFlow(options: {
  url: string;
  interactive: boolean;
}): Promise<string | undefined> {
  const target = getBrowserTarget();
  if (target === "safari" || target === "safari-ios") {
    return launchSafariWebAuthFlow(options);
  }
  return chrome.identity.launchWebAuthFlow(options);
}
