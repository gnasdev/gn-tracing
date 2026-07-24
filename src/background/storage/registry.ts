/**
 * Storage provider registry. Registers Google Drive + Dropbox only.
 * URL parsing may still see legacy `/onedrive/` paths; those fail closed
 * elsewhere and never register here.
 */
import {
  isStorageProviderId,
  normalizeStorageProviderId,
  type StorageProviderId,
} from "../../shared/storage-provider";
import { DropboxProvider } from "./dropbox-provider";
import { GoogleDriveProvider } from "./google-drive-provider";
import type { StorageProvider } from "./types";

const googleDriveProvider = new GoogleDriveProvider();
const dropboxProvider = new DropboxProvider();

const providers: Partial<Record<StorageProviderId, StorageProvider>> = {
  "google-drive": googleDriveProvider,
  dropbox: dropboxProvider,
};

const warnedFallbackProviders = new Set<string>();

export function isStorageProviderRegistered(id: StorageProviderId | unknown): boolean {
  if (!isStorageProviderId(id)) {
    return false;
  }
  return providers[id] != null;
}

/**
 * Returns a registered provider, or falls back to Google Drive so callers never
 * get undefined. Prefer `requireRegisteredStorageProvider` for connect/upload
 * so unknown ids fail explicitly instead of silently using Google.
 */
export function getStorageProvider(id: StorageProviderId | unknown): StorageProvider {
  const normalized = normalizeStorageProviderId(id, "google-drive");
  const provider = providers[normalized];
  if (provider) {
    return provider;
  }

  if (isStorageProviderId(id) && id !== "google-drive" && !warnedFallbackProviders.has(id)) {
    warnedFallbackProviders.add(id);
    console.warn(
      `[storage] Provider "${id}" is not registered in this build; falling back to google-drive. ` +
        "Use requireRegisteredStorageProvider for connect/upload to fail closed.",
    );
  }
  return googleDriveProvider;
}

/**
 * Strict lookup for auth/upload paths. Unknown / unregistered ids return an
 * error instead of silently using Google.
 */
export function requireRegisteredStorageProvider(
  id: StorageProviderId | unknown,
): { ok: true; provider: StorageProvider } | { ok: false; error: string } {
  // Reject removed OneDrive explicitly (isStorageProviderId no longer accepts it).
  if (typeof id === "string" && id.trim().toLowerCase() === "onedrive") {
    return {
      ok: false,
      error: 'Storage provider "onedrive" is not available in this build.',
    };
  }
  const normalized = normalizeStorageProviderId(id, "google-drive");
  const provider = providers[normalized];
  if (!provider) {
    return {
      ok: false,
      error: `Storage provider "${normalized}" is not available in this build.`,
    };
  }
  return { ok: true, provider };
}

/**
 * Provider id used to label metadata / replay URLs for an upload that actually
 * ran through a registered adapter. Unregistered settings clamp to google-drive.
 */
export function resolveRegisteredUploadProviderId(
  requested: StorageProviderId | unknown,
): StorageProviderId {
  const resolved = requireRegisteredStorageProvider(requested);
  return resolved.ok ? resolved.provider.id : googleDriveProvider.id;
}

export function getGoogleDriveProvider(): GoogleDriveProvider {
  return googleDriveProvider;
}

export function getDropboxProvider(): DropboxProvider {
  return dropboxProvider;
}

export function listRegisteredStorageProviders(): StorageProviderId[] {
  return Object.keys(providers) as StorageProviderId[];
}

/** Register (or replace) a provider — used by tests. */
export function registerStorageProvider(provider: StorageProvider): void {
  providers[provider.id] = provider;
}
