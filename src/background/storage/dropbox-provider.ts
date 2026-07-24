/**
 * Dropbox StorageProvider adapter.
 *
 * Auth lives in DropboxAuth (chrome.identity + PKCE). Package I/O is shared via
 * `src/shared/dropbox-api.ts` with the offscreen uploader so share/upload rules
 * cannot drift.
 *
 * After share, `makePublicReadable` returns a **canonical shared-link replay
 * id** (not the Dropbox file id) so standalone `/dropbox/<id>` works without a
 * user token. See dropbox-api.ts header comment.
 */
import {
  DROPBOX_UPLOAD_SESSION_THRESHOLD_BYTES,
  makeDropboxPublicReadable,
  resolveDropboxFolderPath,
  uploadDropboxFile,
} from "../../shared/dropbox-api";
import {
  dropboxFolderPathFromSegments,
  parseDropboxFolderInput,
} from "../../shared/dropbox-folder";
import { buildExternalPlayerUrl } from "../../shared/player-host";
import type { StorageProviderId } from "../../shared/storage-provider";
import { DropboxAuth } from "../dropbox-auth";
import type { ParsedFolderTarget, StorageProvider, UploadProgress } from "./types";

export class DropboxProvider implements StorageProvider {
  readonly id: StorageProviderId = "dropbox";

  constructor(
    private readonly auth: DropboxAuth = new DropboxAuth(),
    private readonly sessionThresholdBytes = DROPBOX_UPLOAD_SESSION_THRESHOLD_BYTES,
  ) {}

  getAuth(): DropboxAuth {
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
    return parseDropboxFolderInput(raw);
  }

  async resolveUploadFolder(authToken: string, target: ParsedFolderTarget): Promise<string | null> {
    if (target.folderPath.length > 0) {
      return resolveDropboxFolderPath(authToken, target.folderPath);
    }
    // Root: Dropbox uses empty path; return null so upload places file at root.
    return null;
  }

  async uploadPackage(args: {
    authToken: string;
    folderId: string | null;
    filename: string;
    blob: Blob;
    onProgress: (p: UploadProgress) => void;
  }): Promise<{ fileId: string }> {
    // folderId for Dropbox is the absolute folder path (or null for root).
    const folderPath =
      typeof args.folderId === "string" && args.folderId ? args.folderId.replace(/\/+$/, "") : "";
    const path = `${folderPath}/${args.filename}`.replace(/\/+/g, "/");
    // Dropbox paths must start with / for non-root, or be /filename at root.
    const absolutePath = path.startsWith("/") ? path : `/${path}`;

    const uploaded = await uploadDropboxFile({
      authToken: args.authToken,
      path: absolutePath,
      blob: args.blob,
      sessionThresholdBytes: this.sessionThresholdBytes,
      onProgress: (p) => args.onProgress(p),
    });
    // Temporary id is the absolute path; makePublicReadable replaces with replay id.
    return { fileId: uploaded.path };
  }

  async makePublicReadable(authToken: string, fileId: string): Promise<{ replayId: string }> {
    // fileId is the absolute Dropbox path from uploadPackage.
    const shared = await makeDropboxPublicReadable(authToken, fileId);
    return { replayId: shared.replayId };
  }

  buildReplayUrl(fileId: string): string {
    return buildExternalPlayerUrl(fileId, this.id);
  }

  /** Path helper for callers that only have folder segments. */
  static folderPathFromTarget(target: ParsedFolderTarget): string {
    return dropboxFolderPathFromSegments(target.folderPath);
  }
}
