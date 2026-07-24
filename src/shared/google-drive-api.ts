/**
 * Google Drive v3 API helpers used by the offscreen uploader and the
 * GoogleDriveProvider adapter. Behavior matches the previous inline
 * implementations in offscreen.ts — extract only, no rewrite.
 *
 * This module is the single source of truth for Drive package I/O (share,
 * folder resolve, multipart/resumable upload). Both the StorageProvider
 * adapter and offscreen call these functions so thresholds and share rules
 * cannot drift between paths.
 */

/** Blobs larger than this use Drive's resumable media upload path (32 MiB). */
export const GOOGLE_DRIVE_RESUMABLE_THRESHOLD_BYTES = 32 * 1024 * 1024;

const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";

export interface GoogleDriveUploadProgress {
  loadedBytes: number;
  totalBytes: number;
}

/**
 * Grants anyone-with-the-link reader access. Hard-fails when the permission
 * cannot be created (standalone player depends on public read).
 */
export async function makeGoogleDrivePublicReadable(
  authToken: string,
  fileId: string,
): Promise<void> {
  const response = await fetch(`${DRIVE_FILES_URL}/${fileId}/permissions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "anyone",
      role: "reader",
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(
      (error as { error?: { message?: string } }).error?.message ||
        `Share permission failed with status ${response.status}`,
    );
  }
}

async function createFolder(
  authToken: string,
  folderName: string,
  parentFolderId?: string | null,
): Promise<string> {
  const response = await fetch(`${DRIVE_FILES_URL}?fields=id&supportsAllDrives=true`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
      ...(parentFolderId ? { parents: [parentFolderId] } : {}),
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(
      (error as { error?: { message?: string } }).error?.message ||
        `Create folder failed with status ${response.status}`,
    );
  }

  const result = (await response.json()) as { id: string };
  await makeGoogleDrivePublicReadable(authToken, result.id);
  return result.id;
}

async function findFolder(
  authToken: string,
  folderName: string,
  parentFolderId?: string | null,
): Promise<string | null> {
  const escapedName = folderName.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const parentQuery = parentFolderId ? `'${parentFolderId}' in parents` : "'root' in parents";
  const query = [
    "mimeType = 'application/vnd.google-apps.folder'",
    "trashed = false",
    `name = '${escapedName}'`,
    parentQuery,
  ].join(" and ");
  const url = new URL(DRIVE_FILES_URL);
  url.searchParams.set("fields", "files(id,name)");
  url.searchParams.set("pageSize", "1");
  url.searchParams.set("q", query);
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${authToken}`,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(
      (error as { error?: { message?: string } }).error?.message ||
        `Find folder failed with status ${response.status}`,
    );
  }

  const result = (await response.json().catch(() => ({}))) as {
    files?: Array<{ id?: string }>;
  };
  const folder = Array.isArray(result.files) ? result.files[0] : null;
  return typeof folder?.id === "string" ? folder.id : null;
}

/**
 * Walks (and creates) a slash-path of folder names under an optional parent.
 */
export async function resolveGoogleDriveFolderPath(
  authToken: string,
  folderPath: string[] | undefined,
  parentFolderId?: string | null,
): Promise<string | null> {
  let currentParentId = parentFolderId || null;
  const safePath = Array.isArray(folderPath)
    ? folderPath.filter((segment) => typeof segment === "string" && segment.trim())
    : [];

  for (const rawSegment of safePath) {
    const segment = rawSegment.trim();
    const existingFolderId = await findFolder(authToken, segment, currentParentId);
    currentParentId = existingFolderId || (await createFolder(authToken, segment, currentParentId));
  }

  return currentParentId;
}

/**
 * Uploads a file to Drive (multipart for smaller blobs, resumable for large).
 * Returns the created file id.
 */
export async function uploadGoogleDriveFile(args: {
  authToken: string;
  filename: string;
  blob: Blob;
  parentId: string | null;
  /** Blobs larger than this use the resumable upload path. */
  resumableThresholdBytes: number;
  onProgress?: (progress: GoogleDriveUploadProgress) => void;
}): Promise<string> {
  const { authToken, filename, blob, parentId, resumableThresholdBytes, onProgress } = args;

  if (blob.size > resumableThresholdBytes) {
    const sessionResponse = await fetch(
      `${DRIVE_UPLOAD_URL}?uploadType=resumable&fields=id&supportsAllDrives=true`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${authToken}`,
          "Content-Type": "application/json",
          "X-Upload-Content-Type": blob.type || "application/octet-stream",
          "X-Upload-Content-Length": String(blob.size),
        },
        body: JSON.stringify({
          name: filename,
          ...(parentId ? { parents: [parentId] } : {}),
        }),
      },
    );

    if (!sessionResponse.ok) {
      const error = await sessionResponse.json().catch(() => ({}));
      throw new Error(
        (error as { error?: { message?: string } }).error?.message ||
          `Start resumable upload failed with status ${sessionResponse.status}`,
      );
    }

    const uploadUrl = sessionResponse.headers.get("Location");
    if (!uploadUrl) {
      throw new Error("Drive did not return a resumable upload URL");
    }

    const result = await new Promise<{ id: string }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", uploadUrl);
      xhr.setRequestHeader("Content-Type", blob.type || "application/octet-stream");
      xhr.upload.addEventListener("progress", (event) => {
        const loaded =
          event.lengthComputable && event.total > 0
            ? Math.min(blob.size, Math.round((event.loaded / event.total) * blob.size))
            : Math.min(event.loaded, blob.size);
        onProgress?.({ loadedBytes: loaded, totalBytes: blob.size });
      });

      xhr.onerror = () => reject(new Error("Upload failed due to a network error"));
      xhr.onload = () => {
        let payload: { id?: string; error?: { message?: string } } = {};
        try {
          payload = xhr.responseText ? JSON.parse(xhr.responseText) : {};
        } catch {
          // ignore parse errors; handled below
        }

        if (xhr.status < 200 || xhr.status >= 300 || !payload.id) {
          reject(new Error(payload.error?.message || `Upload failed with status ${xhr.status}`));
          return;
        }

        resolve({ id: payload.id });
      };

      xhr.send(blob);
    });

    onProgress?.({ loadedBytes: blob.size, totalBytes: blob.size });
    return result.id;
  }

  const metadata = {
    name: filename,
    ...(parentId ? { parents: [parentId] } : {}),
  };
  const formData = new FormData();
  formData.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  formData.append("file", blob, filename);

  const result = await new Promise<{ id: string }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${DRIVE_UPLOAD_URL}?uploadType=multipart&fields=id&supportsAllDrives=true`);
    xhr.setRequestHeader("Authorization", `Bearer ${authToken}`);
    xhr.upload.addEventListener("progress", (event) => {
      const loaded =
        event.lengthComputable && event.total > 0
          ? Math.min(blob.size, Math.round((event.loaded / event.total) * blob.size))
          : Math.min(event.loaded, blob.size);
      onProgress?.({ loadedBytes: loaded, totalBytes: blob.size });
    });

    xhr.onerror = () => reject(new Error("Upload failed due to a network error"));
    xhr.onload = () => {
      let payload: { id?: string; error?: { message?: string } } = {};
      try {
        payload = xhr.responseText ? JSON.parse(xhr.responseText) : {};
      } catch {
        // ignore
      }

      if (xhr.status < 200 || xhr.status >= 300 || !payload.id) {
        reject(new Error(payload.error?.message || `Upload failed with status ${xhr.status}`));
        return;
      }

      resolve({ id: payload.id });
    };

    xhr.send(formData);
  });

  onProgress?.({ loadedBytes: blob.size, totalBytes: blob.size });
  return result.id;
}

/** Authenticated media download URL for extension-player OAuth fetch. */
export function getGoogleDriveAuthenticatedDownloadUrl(fileId: string): string {
  const url = new URL(`${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}`);
  url.searchParams.set("alt", "media");
  url.searchParams.set("supportsAllDrives", "true");
  return url.toString();
}
