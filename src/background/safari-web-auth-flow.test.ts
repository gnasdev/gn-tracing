/**
 * `chrome.tabs`-based stand-in for `chrome.identity.launchWebAuthFlow` on
 * Safari. `globalThis.chrome` is the shared mock installed by `test/setup.ts`.
 */

import { describe, expect, it, vi } from "vitest";
import type { ChromeMock } from "../../test/mocks/chrome";
import { SAFARI_OAUTH_CALLBACK_URL } from "../shared/oauth-redirect-policy";
import { launchSafariWebAuthFlow } from "./safari-web-auth-flow";

function mockChrome(): ChromeMock {
  return globalThis.chrome as unknown as ChromeMock;
}

describe("launchSafariWebAuthFlow", () => {
  it("opens a tab and resolves with the callback URL once the tab navigates there", async () => {
    const chrome = mockChrome();
    const flow = launchSafariWebAuthFlow({ url: "https://accounts.google.com/o/oauth2/auth?x=1" });

    // Let the create() promise resolve before the tab "navigates".
    await Promise.resolve();
    await Promise.resolve();

    expect(chrome.tabs.create.calls[0]?.args[0]).toEqual({
      url: "https://accounts.google.com/o/oauth2/auth?x=1",
    });

    const finalUrl = `${SAFARI_OAUTH_CALLBACK_URL}?code=abc123&state=xyz`;
    chrome.tabs.onUpdated.emit(1, { url: finalUrl });

    await expect(flow).resolves.toBe(finalUrl);
    expect(chrome.tabs.remove.calls[0]?.args[0]).toBe(1);
  });

  it("ignores URL updates on other tabs and updates without a url change", async () => {
    const chrome = mockChrome();
    const flow = launchSafariWebAuthFlow({ url: "https://example.com/auth" });
    await Promise.resolve();
    await Promise.resolve();

    chrome.tabs.onUpdated.emit(999, { url: SAFARI_OAUTH_CALLBACK_URL });
    chrome.tabs.onUpdated.emit(1, {});
    chrome.tabs.onUpdated.emit(1, { url: "https://accounts.google.com/consent" });

    const finalUrl = `${SAFARI_OAUTH_CALLBACK_URL}?code=abc`;
    chrome.tabs.onUpdated.emit(1, { url: finalUrl });

    await expect(flow).resolves.toBe(finalUrl);
  });

  it("rejects when the user closes the tab before completing sign-in", async () => {
    const chrome = mockChrome();
    const flow = launchSafariWebAuthFlow({ url: "https://example.com/auth" });
    await Promise.resolve();
    await Promise.resolve();

    chrome.tabs.onRemoved.emit(1);

    await expect(flow).rejects.toThrow("Sign-in was cancelled");
  });

  it("rejects when the sign-in tab cannot be created", async () => {
    const chrome = mockChrome();
    chrome.tabs.create.mockImplementation(() => Promise.resolve({ id: undefined, windowId: 1 }));

    await expect(launchSafariWebAuthFlow({ url: "https://example.com/auth" })).rejects.toThrow(
      "Could not open the sign-in tab.",
    );
  });

  it("times out and closes the tab if the provider never redirects", async () => {
    vi.useFakeTimers();
    try {
      const chrome = mockChrome();
      const flow = launchSafariWebAuthFlow({ url: "https://example.com/auth" });
      await vi.advanceTimersByTimeAsync(0);

      const assertion = expect(flow).rejects.toThrow("Sign-in timed out.");
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      await assertion;
      expect(chrome.tabs.remove.calls[0]?.args[0]).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes its listeners after settling so a later emit is a no-op", async () => {
    const chrome = mockChrome();
    const flow = launchSafariWebAuthFlow({ url: "https://example.com/auth" });
    await Promise.resolve();
    await Promise.resolve();

    chrome.tabs.onRemoved.emit(1);
    await expect(flow).rejects.toThrow();

    expect(chrome.tabs.onUpdated.listeners).toHaveLength(0);
    expect(chrome.tabs.onRemoved.listeners).toHaveLength(0);
  });
});
