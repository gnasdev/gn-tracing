/**
 * Drive Adapter - Handle folder/file loading from Google Drive in standalone mode
 */

import { getDriveDownloadUrl } from './extension-detector';

interface DriveFileEntry {
  id: string;
  name: string;
  mimeType?: string;
  size?: string;
}

declare global {
  interface Window {
    GN_TRACING_CONFIG: {
      mode: 'extension' | 'standalone';
      driveApiKey?: string;
    };
    GN_DRIVE_ADAPTER?: {
      loadJson: typeof loadDriveJson;
      loadBlob: typeof loadDriveBlob;
      listFolderFiles: typeof listDriveFolderFiles;
    };
  }
}

function buildDriveApiUrl(pathname: string, params: Record<string, string>): string {
  const url = new URL(`https://www.googleapis.com/drive/v3/${pathname}`);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const apiKey = window.GN_TRACING_CONFIG.driveApiKey;
  if (apiKey) {
    url.searchParams.set('key', apiKey);
  }

  return url.toString();
}

export async function loadDriveJson(fileId: string): Promise<unknown> {
  const response = await fetch(getDriveDownloadUrl(fileId));
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  return response.json();
}

export async function loadDriveBlob(fileId: string): Promise<Blob> {
  const response = await fetch(getDriveDownloadUrl(fileId));
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  return response.blob();
}

export async function listDriveFolderFiles(folderId: string): Promise<DriveFileEntry[]> {
  const url = buildDriveApiUrl('files', {
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id,name,mimeType,size)',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
    pageSize: '1000',
  });

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to list Drive folder ${folderId}: HTTP ${response.status}`);
  }

  const payload = await response.json() as { files?: DriveFileEntry[] };
  return Array.isArray(payload.files) ? payload.files : [];
}

export function setupDriveAdapter(): void {
  window.GN_DRIVE_ADAPTER = {
    loadJson: loadDriveJson,
    loadBlob: loadDriveBlob,
    listFolderFiles: listDriveFolderFiles,
  };

  window.GN_TRACING_CONFIG = {
    mode: 'standalone',
    driveApiKey: import.meta.env.VITE_DRIVE_API_KEY || undefined,
  };
}
