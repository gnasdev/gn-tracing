/**
 * Normalizes Google Drive folder inputs pasted or typed by users.
 */
export interface ParsedGoogleDriveFolderInput {
  rawInput: string;
  normalizedInput: string;
  folderId: string | null;
  folderPath: string[];
}

/**
 * Parses user-provided upload folder input.
 *
 * Accepted values intentionally cover the common clipboard shapes users paste:
 * raw Drive folder ids, Drive folder URLs, query-string ids, and slash-prefixed
 * folder paths for folder creation/resolution in the upload flow.
 */
const DRIVE_FOLDER_PATTERNS = [/\/folders\/([a-zA-Z0-9_-]+)/i, /[?&]id=([a-zA-Z0-9_-]+)/i];

function isLikelyDriveId(value: string): boolean {
  return /^[a-zA-Z0-9_-]{10,}$/.test(value);
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

export function parseGoogleDriveFolderInput(
  input: string | null | undefined,
): ParsedGoogleDriveFolderInput {
  const rawInput = typeof input === "string" ? input : "";
  const normalizedInput = rawInput.trim();

  if (!normalizedInput) {
    return {
      rawInput,
      normalizedInput: "",
      folderId: null,
      folderPath: [],
    };
  }

  const parsedPath = parseFolderPath(normalizedInput);
  if (parsedPath) {
    return {
      rawInput,
      normalizedInput: parsedPath.normalizedInput,
      folderId: null,
      folderPath: parsedPath.folderPath,
    };
  }

  if (isLikelyDriveId(normalizedInput)) {
    return {
      rawInput,
      normalizedInput,
      folderId: normalizedInput,
      folderPath: [],
    };
  }

  for (const pattern of DRIVE_FOLDER_PATTERNS) {
    const match = normalizedInput.match(pattern);
    if (match?.[1]) {
      return {
        rawInput,
        normalizedInput,
        folderId: match[1],
        folderPath: [],
      };
    }
  }

  try {
    const url = new URL(normalizedInput);

    if (url.hostname.includes("drive.google.com")) {
      for (const pattern of DRIVE_FOLDER_PATTERNS) {
        const match = `${url.pathname}${url.search}`.match(pattern);
        if (match?.[1]) {
          return {
            rawInput,
            normalizedInput,
            folderId: match[1],
            folderPath: [],
          };
        }
      }
    }
  } catch {
    // Not a URL.
  }

  return {
    rawInput,
    normalizedInput,
    folderId: null,
    folderPath: [],
  };
}
