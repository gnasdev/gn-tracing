/**
 * Resolve the active replay target from the browser location.
 * Delegates to shared parseStorageRecordingRef for path/query rules.
 */
import {
  parseStorageRecordingRef,
  type StorageProviderId,
  type StorageRecordingRef,
} from "../../../src/shared/storage-provider";

export type { StorageProviderId, StorageRecordingRef };

export function resolveReplayRecordingRef(
  href: string = typeof window !== "undefined" ? window.location.href : "",
): StorageRecordingRef | null {
  try {
    return parseStorageRecordingRef(href);
  } catch {
    return null;
  }
}

export function proxyDownloadUrl(ref: StorageRecordingRef): string {
  if (ref.provider === "dropbox") {
    return `/api/dropbox?id=${encodeURIComponent(ref.fileId)}`;
  }
  return `/api/drive?id=${encodeURIComponent(ref.fileId)}`;
}
