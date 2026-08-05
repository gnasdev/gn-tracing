/**
 * The host-permission grant must be its own gesture.
 *
 * Firefox MV3 treats every `host_permissions` entry as optional and not granted, so
 * on a site outside the manifest the only access is `activeTab` — revoked the moment
 * the media host tab takes focus, which the record path must do to get transient
 * activation. Injections after that point failed with "Missing host permission for
 * the tab", leaving console/network evidence empty.
 *
 * The fix cannot share the click that starts capture: awaiting a permission prompt
 * consumes the transient activation and `getDisplayMedia` would fail with
 * InvalidStateError. So the arm panel carries a second button, and these tests keep
 * the two gestures from being merged back together.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const markup = readFileSync(resolve(__dirname, "../../offscreen/offscreen.html"), "utf8");
const source = readFileSync(resolve(__dirname, "offscreen.ts"), "utf8");

function functionBody(name: string, span = 1400): string {
  const start = source.indexOf(name);
  expect(start).toBeGreaterThan(-1);
  return source.slice(start, start + span);
}

describe("arm panel host-permission grant step", () => {
  it("ships a grant button separate from the share button", () => {
    expect(markup).toContain('id="arm-grant"');
    expect(markup).toContain('id="arm-grant-btn"');
    // Hidden by default so Chromium and already-granted Firefox never see it.
    expect(markup).toMatch(/<div id="arm-grant" hidden>/);
  });

  it("explains what is lost without the permission", () => {
    const grantBlock = markup.slice(markup.indexOf('id="arm-grant"'));
    expect(grantBlock).toMatch(/console and network/i);
  });

  it("asks for the same origins the manifest declares as optional", () => {
    const manifest = readFileSync(resolve(__dirname, "../../manifest.template.json"), "utf8");
    const declared = JSON.parse(manifest).optional_host_permissions as string[];
    expect(declared).toEqual(expect.arrayContaining(["http://*/*", "https://*/*"]));
    expect(source).toContain('const RECORDING_HOST_ORIGINS = ["http://*/*", "https://*/*"]');
  });

  it("requests the permission in the grant click, never in the share click", () => {
    expect(functionBody("async function onGrantButtonClick(")).toContain(
      "chrome.permissions.request({ origins: RECORDING_HOST_ORIGINS })",
    );
    // The share click must stay synchronous up to getDisplayMedia.
    expect(functionBody("async function onArmButtonClick(")).not.toContain("permissions.request");
  });

  it("only shows the grant step when the permission is missing", () => {
    const body = functionBody("async function refreshGrantStep(");
    expect(body).toContain("hasRecordingHostPermission()");
    expect(body).toContain("grant.hidden =");
  });

  it("treats an engine without optional host permissions as already granted", () => {
    // Chromium grants host permissions at install; contains() must not gate it.
    expect(functionBody("async function hasRecordingHostPermission(")).toContain("return true");
  });

  it("keeps recording possible when the user declines", () => {
    const body = functionBody("async function onGrantButtonClick(");
    // Declining sets a status and returns; it must not disarm or block capture.
    expect(body).toContain("setArmStatus(");
    expect(body).not.toContain("disarmDisplayCapture(");
    expect(body).toMatch(/video still records/i);
  });
});
