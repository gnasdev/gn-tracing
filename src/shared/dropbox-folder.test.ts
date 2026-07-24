import { describe, expect, it } from "vitest";
import { dropboxFolderPathFromSegments, parseDropboxFolderInput } from "./dropbox-folder";

describe("parseDropboxFolderInput", () => {
  it("treats empty and / as root", () => {
    for (const input of ["", "/", "  ", null, undefined]) {
      expect(parseDropboxFolderInput(input as string | null | undefined)).toEqual({
        rawInput: typeof input === "string" ? input : "",
        normalizedInput: "",
        folderId: null,
        folderPath: [],
      });
    }
  });

  it("parses slash paths into segments", () => {
    const result = parseDropboxFolderInput("/gn-tracing/bugs");
    expect(result.folderPath).toEqual(["gn-tracing", "bugs"]);
    expect(result.normalizedInput).toBe("/gn-tracing/bugs");
    expect(result.folderId).toBeNull();
  });

  it("accepts paths without leading slash", () => {
    const result = parseDropboxFolderInput("gn-tracing");
    expect(result.folderPath).toEqual(["gn-tracing"]);
    expect(result.normalizedInput).toBe("/gn-tracing");
  });

  it("rejects path traversal segments without collapsing to root", () => {
    // Non-empty normalizedInput + empty folderPath lets settings/SW hard-error
    // (same class as invalid Drive input) instead of silently using root.
    const result = parseDropboxFolderInput("/a/../b");
    expect(result.folderPath).toEqual([]);
    expect(result.folderId).toBeNull();
    expect(result.normalizedInput).toBe("/a/../b");
  });
});

describe("dropboxFolderPathFromSegments", () => {
  it("builds absolute paths", () => {
    expect(dropboxFolderPathFromSegments([])).toBe("");
    expect(dropboxFolderPathFromSegments(["gn-tracing"])).toBe("/gn-tracing");
    expect(dropboxFolderPathFromSegments(["a", "b"])).toBe("/a/b");
  });
});
