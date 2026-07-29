import { describe, expect, it } from "vitest";
import { dialogsToCloseWhenOpening, PopupDialogHost } from "./dialog-host";

describe("dialogsToCloseWhenOpening", () => {
  it("returns every open id except the one being opened", () => {
    expect(dialogsToCloseWhenOpening(["settings", "history"], "settings")).toEqual(["history"]);
    expect(dialogsToCloseWhenOpening(["a", "b", "c"], "b").sort()).toEqual(["a", "c"]);
    expect(dialogsToCloseWhenOpening([], "settings")).toEqual([]);
    expect(dialogsToCloseWhenOpening(["settings"], "settings")).toEqual([]);
  });
});

describe("PopupDialogHost", () => {
  it("opens one dialog and reports others to close", () => {
    const host = new PopupDialogHost<"settings" | "history" | "clouds">();
    expect(host.markOpen("settings")).toEqual({ alreadyOpen: false, closedIds: [] });
    expect(host.isOpen("settings")).toBe(true);

    const second = host.markOpen("history");
    expect(second.alreadyOpen).toBe(false);
    expect(second.closedIds).toEqual(["settings"]);
    expect(host.isOpen("settings")).toBe(false);
    expect(host.isOpen("history")).toBe(true);
    expect(host.listOpen()).toEqual(["history"]);
  });

  it("no-ops markOpen when already open", () => {
    const host = new PopupDialogHost<"settings">();
    host.markOpen("settings");
    expect(host.markOpen("settings")).toEqual({ alreadyOpen: true, closedIds: [] });
    expect(host.listOpen()).toEqual(["settings"]);
  });

  it("markClose and anyOpen track state", () => {
    const host = new PopupDialogHost<"a" | "b">();
    host.markOpen("a");
    expect(host.anyOpen()).toBe(true);
    expect(host.markClose("a")).toBe(true);
    expect(host.markClose("a")).toBe(false);
    expect(host.anyOpen()).toBe(false);
  });
});
