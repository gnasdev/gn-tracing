/**
 * Popup open/close policy for upload vs uploaded-item navigation.
 * Drives the shipped helpers — not a reimplementation of popup.ts.
 */
import { describe, expect, it, vi } from "vitest";
import {
  openPopupExternalUrl,
  popupTabOpenModeForHistoryAction,
  popupTabOpenModeForSessionAction,
} from "./popup-navigation";

describe("popupTabOpenModeForSessionAction", () => {
  it("keeps the popup open when uploading a recorded session", () => {
    expect(popupTabOpenModeForSessionAction("upload-session")).toBe("keep-popup-open");
  });

  it("closes the popup when opening an uploaded session's replay or remote link", () => {
    expect(popupTabOpenModeForSessionAction("open-replay")).toBe("open-and-close-popup");
    expect(popupTabOpenModeForSessionAction("open-remote")).toBe("open-and-close-popup");
    expect(popupTabOpenModeForSessionAction("open-folder")).toBe("open-and-close-popup");
  });

  it("keeps the popup open for non-navigation session actions", () => {
    expect(popupTabOpenModeForSessionAction("copy-link")).toBe("keep-popup-open");
    expect(popupTabOpenModeForSessionAction("delete-session")).toBe("keep-popup-open");
  });
});

describe("popupTabOpenModeForHistoryAction", () => {
  it("closes the popup when opening uploaded history items in a new tab", () => {
    expect(popupTabOpenModeForHistoryAction("open-replay")).toBe("open-and-close-popup");
    expect(popupTabOpenModeForHistoryAction("open-remote")).toBe("open-and-close-popup");
    expect(popupTabOpenModeForHistoryAction("open-folder")).toBe("open-and-close-popup");
  });

  it("keeps the popup open for copy/delete on history items", () => {
    expect(popupTabOpenModeForHistoryAction("copy-link")).toBe("keep-popup-open");
    expect(popupTabOpenModeForHistoryAction("delete-history")).toBe("keep-popup-open");
  });
});

describe("openPopupExternalUrl", () => {
  it("opens the tab then closes the popup for navigation mode", async () => {
    const createTab = vi.fn(async () => ({ id: 1 }));
    const closePopup = vi.fn();
    await openPopupExternalUrl("https://example.com/replay", {
      mode: "open-and-close-popup",
      createTab,
      closePopup,
    });
    expect(createTab).toHaveBeenCalledWith("https://example.com/replay");
    expect(closePopup).toHaveBeenCalledOnce();
  });

  it("opens the tab without closing the popup when mode is keep-popup-open", async () => {
    const createTab = vi.fn(async () => ({ id: 1 }));
    const closePopup = vi.fn();
    await openPopupExternalUrl("https://example.com/keep", {
      mode: "keep-popup-open",
      createTab,
      closePopup,
    });
    expect(createTab).toHaveBeenCalledWith("https://example.com/keep");
    expect(closePopup).not.toHaveBeenCalled();
  });

  it("still closes the popup after a failed tab create in open-and-close mode", async () => {
    const createTab = vi.fn(async () => {
      throw new Error("tabs.create failed");
    });
    const closePopup = vi.fn();
    await expect(
      openPopupExternalUrl("https://example.com/fail", {
        mode: "open-and-close-popup",
        createTab,
        closePopup,
      }),
    ).rejects.toThrow(/tabs\.create failed/);
    expect(closePopup).toHaveBeenCalledOnce();
  });
});
