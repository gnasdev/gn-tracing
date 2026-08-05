/**
 * Unit tests for Manage clouds page model — drives the real shipped helpers.
 */
import { describe, expect, it } from "vitest";
import {
  buildProviderRowModel,
  isProviderConnected,
  MANAGE_CLOUDS_PAGE_REL,
  MANAGE_CLOUDS_PROVIDERS,
  resolveManageCloudsPageUrl,
  storageProviderDisplayName,
  storageProviderMessage,
} from "./page-model";

const copy = {
  connected: "Connected",
  notConnected: "Not connected",
  working: "Working…",
  disconnect: "Disconnect",
  connectProvider: (name: string) => `Connect ${name}`,
};

describe("resolveManageCloudsPageUrl", () => {
  it("resolves the packaged extension path via getURL", () => {
    const url = resolveManageCloudsPageUrl((path) => `chrome-extension://extid/${path}`);
    expect(url).toBe(`chrome-extension://extid/${MANAGE_CLOUDS_PAGE_REL}`);
    expect(url.endsWith("manage-clouds/manage-clouds.html")).toBe(true);
  });
});

describe("MANAGE_CLOUDS_PROVIDERS", () => {
  it("lists Drive and Dropbox only", () => {
    expect([...MANAGE_CLOUDS_PROVIDERS]).toEqual(["google-drive", "dropbox"]);
  });
});

describe("storageProviderDisplayName", () => {
  it("names known providers", () => {
    expect(storageProviderDisplayName("google-drive")).toBe("Google Drive");
    expect(storageProviderDisplayName("dropbox")).toBe("Dropbox");
  });
});

describe("isProviderConnected", () => {
  it("requires ok and isConnected", () => {
    expect(isProviderConnected({ ok: true, isConnected: true })).toBe(true);
    expect(isProviderConnected({ ok: true, isConnected: false })).toBe(false);
    expect(isProviderConnected({ ok: false, isConnected: true })).toBe(false);
    expect(isProviderConnected(null)).toBe(false);
  });
});

describe("buildProviderRowModel", () => {
  it("builds connect CTA when disconnected", () => {
    const row = buildProviderRowModel("google-drive", {
      connected: false,
      busy: false,
      error: null,
      copy,
    });
    expect(row.actionLabel).toBe("Connect Google Drive");
    expect(row.actionIsPrimary).toBe(true);
    expect(row.statusKind).toBe("idle");
  });

  it("builds disconnect CTA when connected", () => {
    const row = buildProviderRowModel("dropbox", {
      connected: true,
      busy: false,
      error: null,
      copy,
    });
    expect(row.actionLabel).toBe("Disconnect");
    expect(row.actionIsPrimary).toBe(false);
    expect(row.statusKind).toBe("connected");
    expect(row.statusText).toBe("Connected");
  });

  it("surfaces busy and error states", () => {
    const busy = buildProviderRowModel("google-drive", {
      connected: false,
      busy: true,
      error: null,
      copy,
    });
    expect(busy.statusKind).toBe("busy");
    expect(busy.statusText).toBe("Working…");

    const err = buildProviderRowModel("dropbox", {
      connected: false,
      busy: false,
      error: "redirect_uri_mismatch",
      copy,
    });
    expect(err.statusKind).toBe("error");
    expect(err.statusText).toBe("redirect_uri_mismatch");
  });
});

describe("storageProviderMessage", () => {
  it("builds STORAGE_* messages with provider data", () => {
    expect(storageProviderMessage("STORAGE_CONNECT", "google-drive")).toEqual({
      action: "STORAGE_CONNECT",
      data: { provider: "google-drive" },
    });
    expect(storageProviderMessage("STORAGE_DISCONNECT", "dropbox")).toEqual({
      action: "STORAGE_DISCONNECT",
      data: { provider: "dropbox" },
    });
    expect(storageProviderMessage("STORAGE_STATUS", "google-drive").action).toBe("STORAGE_STATUS");
  });
});
