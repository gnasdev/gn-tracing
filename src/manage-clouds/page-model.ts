/**
 * Pure helpers for the Manage clouds extension page.
 * Kept free of chrome.* so unit tests can drive the real module.
 */

export const MANAGE_CLOUDS_PAGE_REL = "manage-clouds/manage-clouds.html";

export type CloudProviderId = "google-drive" | "dropbox";

export const MANAGE_CLOUDS_PROVIDERS: readonly CloudProviderId[] = [
  "google-drive",
  "dropbox",
] as const;

export function resolveManageCloudsPageUrl(getURL: (path: string) => string): string {
  return getURL(MANAGE_CLOUDS_PAGE_REL);
}

export function storageProviderDisplayName(provider: string | undefined): string {
  if (provider === "dropbox") return "Dropbox";
  return "Google Drive";
}

export function isProviderConnected(
  status: { ok?: boolean; isConnected?: boolean } | null | undefined,
): boolean {
  return Boolean(status?.ok && status.isConnected);
}

export type ProviderRowCopy = {
  connected: string;
  notConnected: string;
  working: string;
  disconnect: string;
  connectProvider: (name: string) => string;
};

export type ProviderRowModel = {
  id: CloudProviderId;
  name: string;
  connected: boolean;
  busy: boolean;
  error: string | null;
  statusText: string;
  statusKind: "busy" | "error" | "connected" | "idle";
  actionLabel: string;
  actionIsPrimary: boolean;
};

export function buildProviderRowModel(
  id: CloudProviderId,
  options: {
    connected: boolean;
    busy: boolean;
    error: string | null;
    copy: ProviderRowCopy;
  },
): ProviderRowModel {
  const name = storageProviderDisplayName(id);
  if (options.busy) {
    return {
      id,
      name,
      connected: options.connected,
      busy: true,
      error: options.error,
      statusText: options.copy.working,
      statusKind: "busy",
      actionLabel: options.connected ? options.copy.disconnect : options.copy.connectProvider(name),
      actionIsPrimary: !options.connected,
    };
  }
  if (options.error) {
    return {
      id,
      name,
      connected: options.connected,
      busy: false,
      error: options.error,
      statusText: options.error,
      statusKind: "error",
      actionLabel: options.connected ? options.copy.disconnect : options.copy.connectProvider(name),
      actionIsPrimary: !options.connected,
    };
  }
  if (options.connected) {
    return {
      id,
      name,
      connected: true,
      busy: false,
      error: null,
      statusText: options.copy.connected,
      statusKind: "connected",
      actionLabel: options.copy.disconnect,
      actionIsPrimary: false,
    };
  }
  return {
    id,
    name,
    connected: false,
    busy: false,
    error: null,
    statusText: options.copy.notConnected,
    statusKind: "idle",
    actionLabel: options.copy.connectProvider(name),
    actionIsPrimary: true,
  };
}

/** Message payload for STORAGE_CONNECT / STORAGE_DISCONNECT. */
export function storageProviderMessage(
  action: "STORAGE_CONNECT" | "STORAGE_DISCONNECT" | "STORAGE_STATUS",
  provider: CloudProviderId,
): { action: string; data: { provider: CloudProviderId } } {
  return { action, data: { provider } };
}
