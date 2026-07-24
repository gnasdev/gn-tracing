/**
 * Storage provider contract for multi-cloud upload/auth.
 *
 * Active providers: Google Drive + Dropbox.
 */
import type { ParsedDropboxFolderInput } from "../../shared/dropbox-folder";
import type { ParsedGoogleDriveFolderInput } from "../../shared/google-drive-folder";
import type { StorageProviderId } from "../../shared/storage-provider";

/**
 * Folder parse result shared across providers.
 * Drive may set folderId; Dropbox uses folderPath only (folderId null).
 */
export type ParsedFolderTarget = ParsedGoogleDriveFolderInput | ParsedDropboxFolderInput;

export interface UploadProgress {
  loadedBytes: number;
  totalBytes: number;
}

/**
 * Result of makePublicReadable. `replayId` is what goes into buildReplayUrl /
 * history — for Drive this equals the file id; for Dropbox it is the canonical
 * shared-link fragment. Anonymous download works without a user token.
 */
export interface MakePublicReadableResult {
  replayId: string;
}

export interface StorageProvider {
  readonly id: StorageProviderId;

  // Auth
  connect(): Promise<{ ok: boolean; error?: string; message?: string }>;
  disconnect(): Promise<{ ok: boolean; error?: string; message?: string }>;
  getAuthToken(): Promise<string | null>;
  isConnected(): Promise<boolean>;

  // Folder (path / id / provider-specific link)
  parseFolderInput(raw: string): ParsedFolderTarget;
  resolveUploadFolder(authToken: string, target: ParsedFolderTarget): Promise<string | null>;

  // Package
  uploadPackage(args: {
    authToken: string;
    folderId: string | null;
    filename: string;
    blob: Blob;
    onProgress: (p: UploadProgress) => void;
  }): Promise<{ fileId: string }>;

  makePublicReadable(authToken: string, fileId: string): Promise<MakePublicReadableResult>;

  // Replay
  buildReplayUrl(fileId: string): string;
  /** Optional authenticated media URL for extension player (GET + Bearer). */
  getAuthenticatedDownloadUrl?(fileId: string): string;
}
