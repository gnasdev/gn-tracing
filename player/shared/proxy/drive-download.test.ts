/**
 * Drive download proxy pure helpers (confirm HTML, file id validation).
 */

import { describe, expect, it } from "vitest";
import { createDriveDownloadUrl, extractConfirmedDownloadUrl } from "./drive-download.js";
import { parseDriveFileId } from "./file-id.js";

describe("parseDriveFileId", () => {
  it("accepts typical Drive ids", () => {
    expect(parseDriveFileId("1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms")).toEqual({
      ok: true,
      id: "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms",
    });
  });

  it("rejects empty, URLs, and path characters", () => {
    expect(parseDriveFileId("")).toMatchObject({ ok: false });
    expect(parseDriveFileId("https://drive.google.com/file/d/x")).toMatchObject({ ok: false });
    expect(parseDriveFileId("../etc/passwd")).toMatchObject({ ok: false });
    expect(parseDriveFileId("ab")).toMatchObject({ ok: false });
  });
});

describe("extractConfirmedDownloadUrl", () => {
  it("extracts confirm from href", () => {
    const fallback = createDriveDownloadUrl("abc123def");
    // Drive confirm links may use raw & in the attribute value after HTML parse.
    const html = `<a href="/download?id=abc123def&confirm=t&uuid=u1">Download</a>`;
    const url = extractConfirmedDownloadUrl(html, fallback);
    expect(url).not.toBeNull();
    expect(url?.searchParams.get("confirm")).toBe("t");
  });

  it("extracts confirm from form fields", () => {
    const fallback = createDriveDownloadUrl("abc123def");
    const html = `<form action="/uc"><input name="confirm" value="t"><input name="id" value="abc123def"></form>`;
    const url = extractConfirmedDownloadUrl(html, fallback);
    expect(url).not.toBeNull();
    expect(url?.searchParams.get("confirm")).toBe("t");
    expect(url?.searchParams.get("id")).toBe("abc123def");
  });

  it("returns null when no confirm token is present", () => {
    const fallback = createDriveDownloadUrl("abc123def");
    expect(extractConfirmedDownloadUrl("<html>nope</html>", fallback)).toBeNull();
  });
});
