/**
 * Google Drive StorageProvider adapter.
 *
 * Wraps existing GoogleDriveAuth + folder parser + Drive API helpers without
 * rewriting Drive behavior. Package upload/share/folder helpers live in
 * `src/shared/google-drive-api.ts` — the same module offscreen uses — so the
 * StorageProvider interface and the real upload pipeline cannot diverge on
 * threshold/share rules (see GOOGLE_DRIVE_RESUMABLE_THRESHOLD_BYTES).
 *
 * Offscreen cannot import this background class (auth + chrome.identity), so
 * package I/O is shared via google-drive-api rather than calling
 * `provider.uploadPackage` from the offscreen document.
 */
import {
  GOOGLE_DRIVE_RESUMABLE_THRESHOLD_BYTES,
  getGoogleDriveAuthenticatedDownloadUrl,
  makeGoogleDrivePublicReadable,
  resolveGoogleDriveFolderPath,
  uploadGoogleDriveFile,
} from "../../shared/google-drive-api";
import { parseGoogleDriveFolderInput } from "../../shared/google-drive-folder";
import { buildExternalPlayerUrl } from "../../shared/player-host";
import type { StorageProviderId } from "../../shared/storage-provider";
import { GoogleDriveAuth } from "../google-drive-auth";
import type { ParsedFolderTarget, StorageProvider, UploadProgress } from "./types";

export class GoogleDriveProvider implements StorageProvider {
  readonly id: StorageProviderId = "google-drive";

  constructor(
    private readonly auth: GoogleDriveAuth = new GoogleDriveAuth(),
    private readonly resumableThresholdBytes = GOOGLE_DRIVE_RESUMABLE_THRESHOLD_BYTES,
  ) {}

  /** Expose underlying auth for SW lifecycle hooks (initialize, mirrored state). */
  getAuth(): GoogleDriveAuth {
    return this.auth;
  }

  async connect(): Promise<{ ok: boolean; error?: string; message?: string }> {
    const result = await this.auth.launchOAuthFlow();
    return { ok: result.ok, error: result.error, message: result.message };
  }

  async disconnect(): Promise<{ ok: boolean; error?: string; message?: string }> {
    const result = await this.auth.disconnect();
    return { ok: result.ok, error: result.error, message: result.message };
  }

  async getAuthToken(): Promise<string | null> {
    return this.auth.getAuthToken();
  }

  async isConnected(): Promise<boolean> {
    const status = await this.auth.getStatus();
    return status.isConnected;
  }

  parseFolderInput(raw: string): ParsedFolderTarget {
    return parseGoogleDriveFolderInput(raw);
  }

  async resolveUploadFolder(authToken: string, target: ParsedFolderTarget): Promise<string | null> {
    if (target.folderId) {
      return target.folderId;
    }
    if (target.folderPath.length > 0) {
      return resolveGoogleDriveFolderPath(authToken, target.folderPath, null);
    }
    return null;
  }

  async uploadPackage(args: {
    authToken: string;
    folderId: string | null;
    filename: string;
    blob: Blob;
    onProgress: (p: UploadProgress) => void;
  }): Promise<{ fileId: string }> {
    const fileId = await uploadGoogleDriveFile({
      authToken: args.authToken,
      filename: args.filename,
      blob: args.blob,
      parentId: args.folderId,
      resumableThresholdBytes: this.resumableThresholdBytes,
      onProgress: (p) => args.onProgress(p),
    });
    return { fileId };
  }

  async makePublicReadable(authToken: string, fileId: string): Promise<{ replayId: string }> {
    await makeGoogleDrivePublicReadable(authToken, fileId);
    // Drive file id is already the public-readable object id for /api/drive.
    return { replayId: fileId };
  }

  buildReplayUrl(fileId: string): string {
    return buildExternalPlayerUrl(fileId, this.id);
  }

  getAuthenticatedDownloadUrl(fileId: string): string {
    return getGoogleDriveAuthenticatedDownloadUrl(fileId);
  }
}
