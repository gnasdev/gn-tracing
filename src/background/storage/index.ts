/**
 * Public surface for multi-cloud storage providers.
 *
 * Keep this barrel minimal: only symbols used outside `src/background/storage/`.
 * Provider classes and registry mutators stay module-private or test-imported
 * from their defining files.
 */
export {
  getDropboxProvider,
  getGoogleDriveProvider,
  requireRegisteredStorageProvider,
  resolveRegisteredUploadProviderId,
} from "./registry";
export type { StorageProvider } from "./types";
