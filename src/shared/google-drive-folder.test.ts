/**
 * Unit tests for the pure Google Drive folder input parser. The function maps
 * the clipboard shapes users paste (raw ids, folder URLs, query-string ids, and
 * slash-prefixed folder paths) to a normalized result, so these tests cover
 * each accepted shape plus the rejection/fallback branches.
 */
import { describe, expect, it } from "vitest";
import { parseGoogleDriveFolderInput } from "./google-drive-folder";

describe("parseGoogleDriveFolderInput", () => {
  it("returns an empty result for null, undefined, or blank input", () => {
    for (const input of [null, undefined, "", "   "]) {
      expect(parseGoogleDriveFolderInput(input)).toEqual({
        rawInput: typeof input === "string" ? input : "",
        normalizedInput: "",
        folderId: null,
        folderPath: [],
      });
    }
  });

  it("parses a slash-prefixed folder path into trimmed segments", () => {
    const result = parseGoogleDriveFolderInput("/ Reports / 2024 / Q1 ");
    expect(result.folderPath).toEqual(["Reports", "2024", "Q1"]);
    expect(result.normalizedInput).toBe("/Reports/2024/Q1");
    expect(result.folderId).toBeNull();
  });

  it("returns an empty path for a bare slash", () => {
    const result = parseGoogleDriveFolderInput("/");
    expect(result.folderPath).toEqual([]);
    expect(result.normalizedInput).toBe("");
  });

  it("rejects folder paths containing . or .. segments", () => {
    const result = parseGoogleDriveFolderInput("/reports/../secret");
    // Falls through path parsing; treated as a non-path, non-id, non-url value.
    expect(result.folderId).toBeNull();
    expect(result.folderPath).toEqual([]);
  });

  it("recognizes a raw Drive id", () => {
    const result = parseGoogleDriveFolderInput("1AbCdEfGhIjKlMnOp");
    expect(result.folderId).toBe("1AbCdEfGhIjKlMnOp");
    expect(result.folderPath).toEqual([]);
  });

  it("extracts the id from a /folders/ URL", () => {
    const result = parseGoogleDriveFolderInput(
      "https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp?usp=sharing",
    );
    expect(result.folderId).toBe("1AbCdEfGhIjKlMnOp");
  });

  it("extracts the id from an ?id= query string", () => {
    const result = parseGoogleDriveFolderInput(
      "https://drive.google.com/open?id=1AbCdEfGhIjKlMnOp",
    );
    expect(result.folderId).toBe("1AbCdEfGhIjKlMnOp");
  });

  it("returns no id for a non-matching, short value", () => {
    const result = parseGoogleDriveFolderInput("hello");
    expect(result.folderId).toBeNull();
    expect(result.folderPath).toEqual([]);
    expect(result.normalizedInput).toBe("hello");
  });

  it("returns no id for an unrelated URL", () => {
    const result = parseGoogleDriveFolderInput("https://example.com/some/page");
    expect(result.folderId).toBeNull();
  });
});
