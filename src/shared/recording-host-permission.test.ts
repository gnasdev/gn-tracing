/**
 * Shared host-permission helpers used by popup pre-request and arm-panel grant.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureRecordingHostPermission,
  hasRecordingHostPermission,
  RECORDING_HOST_ORIGINS,
  requestRecordingHostPermission,
} from "./recording-host-permission";

describe("recording-host-permission", () => {
  beforeEach(() => {
    vi.stubGlobal("chrome", {
      permissions: {
        contains: vi.fn(),
        request: vi.fn(),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("declares the same origins as optional_host_permissions", () => {
    expect([...RECORDING_HOST_ORIGINS]).toEqual(["http://*/*", "https://*/*"]);
  });

  it("reports granted when contains returns true", async () => {
    (chrome.permissions.contains as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    await expect(hasRecordingHostPermission()).resolves.toBe(true);
    expect(chrome.permissions.contains).toHaveBeenCalledWith({
      origins: ["http://*/*", "https://*/*"],
    });
  });

  it("treats missing permissions API as already granted", async () => {
    (chrome.permissions.contains as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("no optional permissions"),
    );
    await expect(hasRecordingHostPermission()).resolves.toBe(true);
  });

  it("requests origins and returns the grant result", async () => {
    (chrome.permissions.request as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    await expect(requestRecordingHostPermission()).resolves.toBe(false);
    expect(chrome.permissions.request).toHaveBeenCalledWith({
      origins: ["http://*/*", "https://*/*"],
    });
  });

  it("ensureRecordingHostPermission calls request without awaiting contains first", async () => {
    // Firefox drops the user gesture at the first await. contains() is async, so
    // ensure must not gate request() behind it. request() itself shows no prompt
    // when access is already held.
    (chrome.permissions.request as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    await expect(ensureRecordingHostPermission()).resolves.toBe(true);
    expect(chrome.permissions.request).toHaveBeenCalledWith({
      origins: ["http://*/*", "https://*/*"],
    });
    expect(chrome.permissions.contains).not.toHaveBeenCalled();
  });

  it("ensureRecordingHostPermission returns false when the user declines", async () => {
    (chrome.permissions.request as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    await expect(ensureRecordingHostPermission()).resolves.toBe(false);
  });

  it("source documents request-without-prior-await for Firefox gestures", () => {
    const source = readFileSync(resolve(__dirname, "./recording-host-permission.ts"), "utf8");
    const ensureAt = source.indexOf("export async function ensureRecordingHostPermission");
    expect(ensureAt).toBeGreaterThan(-1);
    const body = source.slice(ensureAt, ensureAt + 500);
    expect(body).toContain("requestRecordingHostPermission");
    expect(body).not.toContain("hasRecordingHostPermission");
    expect(body).not.toContain("contains");
  });
});

describe("popup pre-requests host permission without a grant-only tab", () => {
  const popupSource = readFileSync(resolve(__dirname, "../popup/popup.ts"), "utf8");
  const registrationSource = readFileSync(
    resolve(__dirname, "../background/instant-replay-registration.ts"),
    "utf8",
  );

  it("Start uses platform preflight; Instant Replay enable requests host permission from the popup", () => {
    // Firefox Start opens the OS share picker first (gesture). Host permission
    // is requested after the stream is live so the permission dialog cannot cancel
    // the picker. Media host is parked only after share succeeds.
    expect(popupSource).toContain("runRecordingStartPreflight");
    const clickAt = popupSource.indexOf('toggleBtn.addEventListener("click"');
    expect(clickAt).toBeGreaterThan(-1);
    const clickBody = popupSource.slice(clickAt, clickAt + 2400);
    expect(clickBody).toContain("beginDisplayMediaFromGesture");
    expect(clickBody).toContain("startRecordingSession({");
    expect(clickBody).toContain("firefoxShare");
    const shareAt = clickBody.indexOf("beginDisplayMediaFromGesture");
    const firstRealAwait = clickBody.search(/^[ \t]*const currentState = await /m);
    expect(shareAt).toBeGreaterThan(-1);
    expect(firstRealAwait).toBeGreaterThan(-1);
    expect(shareAt).toBeLessThan(firstRealAwait);
    expect(clickBody.indexOf("parkMediaHostWindowFromPopup")).toBe(-1);

    const startAt = popupSource.indexOf("async function startRecordingSession(");
    expect(startAt).toBeGreaterThan(-1);
    const startBody = popupSource.slice(startAt, startAt + 2800);
    expect(startBody).toContain("completeFirefoxPopupShare");

    const handoffAt = popupSource.indexOf("async function completeFirefoxPopupShare(");
    expect(handoffAt).toBeGreaterThan(-1);
    const handoffBody = popupSource.slice(handoffAt, handoffAt + 2800);
    expect(handoffBody.indexOf("parkMediaHostWindowFromPopup")).toBeGreaterThan(
      handoffBody.indexOf("streamPromise"),
    );
    expect(handoffBody.indexOf("ensureRecordingHostPermission")).toBeGreaterThan(
      handoffBody.indexOf("parkMediaHostWindowFromPopup"),
    );
    expect(handoffBody).toContain("mediaPrearmed: true");

    // Instant Replay enable still prompts directly (shared Chrome/Firefox path).
    expect(popupSource).toContain("ensureRecordingHostPermission");
    const irAt = popupSource.indexOf("async function saveInstantReplayEnabled(");
    expect(irAt).toBeGreaterThan(-1);
    const irBody = popupSource.slice(irAt, irAt + 1800);
    expect(irBody).toContain("ensureRecordingHostPermission");
    expect(irBody.indexOf("UPDATE_SETTINGS")).toBeGreaterThan(
      irBody.indexOf("ensureRecordingHostPermission"),
    );
    expect(irBody).not.toContain("tabs.create");
    expect(startBody).not.toMatch(/tabs\.create.*permission|permission.*tabs\.create/i);
  });

  it("service worker does not prompt for host permission (gesture lives in popup)", () => {
    // createRegistrationDeps must not call requestRecordingHostPermission —
    // that would run without a user gesture and/or force a grant page tab.
    const depsAt = registrationSource.indexOf("export function createRegistrationDeps");
    expect(depsAt).toBeGreaterThan(-1);
    const depsBody = registrationSource.slice(depsAt, depsAt + 1200);
    expect(depsBody).toContain("requestHostPermission");
    expect(depsBody).not.toContain("requestRecordingHostPermission()");
    expect(depsBody).toMatch(/requestHostPermission:\s*async\s*\(\)\s*=>\s*false/);
  });
});

describe("popup closes only when navigating out, not on upload", () => {
  const popupSource = readFileSync(resolve(__dirname, "../popup/popup.ts"), "utf8");

  it("openExternalUrl closes the popup after opening a tab", () => {
    const openAt = popupSource.indexOf("function openExternalUrl(");
    expect(openAt).toBeGreaterThan(-1);
    const body = popupSource.slice(openAt, openAt + 500);
    expect(body).toContain('mode: "open-and-close-popup"');
    expect(body).toContain("window.close");
    expect(body).toContain("openPopupExternalUrl");
  });

  it("upload-session keeps the popup open (no window.close on that path)", () => {
    const uploadAt = popupSource.indexOf('if (action === "upload-session")');
    expect(uploadAt).toBeGreaterThan(-1);
    const body = popupSource.slice(uploadAt, uploadAt + 900);
    expect(body).toContain("UPLOAD_TO_GOOGLE_DRIVE");
    expect(body).not.toContain("window.close");
    expect(body).toContain("keep-popup-open");
  });
});
