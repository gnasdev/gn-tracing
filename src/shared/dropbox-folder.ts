/**
 * Normalizes Dropbox folder inputs typed by users (slash paths or root).
 *
 * Dropbox identifies folders by path (e.g. `/gn-tracing`), not Drive-style
 * folder ids. Empty / `/` means app root (or account root for full Dropbox apps).
 */

export interface ParsedDropboxFolderInput {
  rawInput: string;
  normalizedInput: string;
  /** Always null for Dropbox path-based folders (kept for ParsedFolderTarget shape). */
  folderId: string | null;
  /** Path segments under root, e.g. ["gn-tracing", "bugs"]. */
  folderPath: string[];
}

function parseFolderPath(value: string): { normalizedInput: string; folderPath: string[] } | null {
  if (!value.startsWith("/")) {
    return null;
  }

  const folderPath = value
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (folderPath.length === 0) {
    return {
      normalizedInput: "",
      folderPath: [],
    };
  }

  if (folderPath.some((segment) => segment === "." || segment === "..")) {
    return null;
  }

  return {
    normalizedInput: `/${folderPath.join("/")}`,
    folderPath,
  };
}

/**
 * Parses user-provided Dropbox upload folder input.
 *
 * Accepted values:
 * - blank or `/` → root
 * - `/folder/sub` slash path (created on upload if missing)
 */
export function parseDropboxFolderInput(
  input: string | null | undefined,
): ParsedDropboxFolderInput {
  const rawInput = typeof input === "string" ? input : "";
  const trimmed = rawInput.trim();

  if (!trimmed || trimmed === "/") {
    return {
      rawInput,
      normalizedInput: "",
      folderId: null,
      folderPath: [],
    };
  }

  // Allow paths without leading slash (treat as absolute under root).
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const parsedPath = parseFolderPath(withSlash);
  if (parsedPath) {
    return {
      rawInput,
      normalizedInput: parsedPath.normalizedInput,
      folderId: null,
      folderPath: parsedPath.folderPath,
    };
  }

  // Invalid non-empty path (e.g. traversal `/a/../b`). Preserve a non-empty
  // normalizedInput with empty folderPath so settings can reject it (same class
  // as invalid Drive input) instead of silently treating it as root.
  return {
    rawInput,
    normalizedInput: withSlash,
    folderId: null,
    folderPath: [],
  };
}

/** Absolute Dropbox API path for a folder path array ("" = root). */
export function dropboxFolderPathFromSegments(folderPath: string[] | undefined): string {
  const segments = Array.isArray(folderPath)
    ? folderPath.filter((segment) => typeof segment === "string" && segment.trim())
    : [];
  if (segments.length === 0) {
    return "";
  }
  return `/${segments.map((s) => s.trim()).join("/")}`;
}
