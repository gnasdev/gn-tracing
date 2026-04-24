export interface ParsedGoogleDriveFolderInput {
  rawInput: string;
  normalizedInput: string;
  folderId: string | null;
}

const DRIVE_FOLDER_PATTERNS = [
  /\/folders\/([a-zA-Z0-9_-]+)/i,
  /[?&]id=([a-zA-Z0-9_-]+)/i,
];

function isLikelyDriveId(value: string): boolean {
  return /^[a-zA-Z0-9_-]{10,}$/.test(value);
}

export function parseGoogleDriveFolderInput(input: string | null | undefined): ParsedGoogleDriveFolderInput {
  const rawInput = typeof input === "string" ? input : "";
  const normalizedInput = rawInput.trim();

  if (!normalizedInput) {
    return {
      rawInput,
      normalizedInput: "",
      folderId: null,
    };
  }

  if (isLikelyDriveId(normalizedInput)) {
    return {
      rawInput,
      normalizedInput,
      folderId: normalizedInput,
    };
  }

  for (const pattern of DRIVE_FOLDER_PATTERNS) {
    const match = normalizedInput.match(pattern);
    if (match?.[1]) {
      return {
        rawInput,
        normalizedInput,
        folderId: match[1],
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
  };
}
