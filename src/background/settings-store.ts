import { parseDropboxFolderInput } from "../shared/dropbox-folder";
import { parseGoogleDriveFolderInput } from "../shared/google-drive-folder";
import { normalizeInstantReplayAllowedDomains } from "../shared/instant-replay-domain";
import {
  INSTANT_REPLAY_WINDOW_SECONDS_DEFAULT,
  normalizeInstantReplayWindowSeconds,
} from "../shared/instant-replay-window";
import { buildExternalPlayerUrl, resolveReplayOpenUrl } from "../shared/player-host";
import { getPrivacyProfileSettings, normalizeMaskDomSelectors } from "../shared/privacy-redaction";
import {
  normalizeStorageProviderId,
  parseStorageRecordingRef,
  type StorageProviderId,
} from "../shared/storage-provider";
import type {
  ConsolePreviewDepth,
  ConsoleSourceSnippetMode,
  ConsoleStackMode,
  HeaderCaptureMode,
  InitiatorCaptureMode,
  PopupState,
  PrivacyRedactionSettings,
  RedirectHeaderCaptureMode,
  ResponseBodyCaptureMode,
  UploadHistoryEntry,
  UploadSettings,
} from "../types/messages";

export {
  normalizeInstantReplayAllowedDomains,
  normalizeInstantReplayDomainPattern,
  tabUrlMatchesInstantReplayAllowlist,
} from "../shared/instant-replay-domain";
export {
  INSTANT_REPLAY_WINDOW_PRESETS,
  INSTANT_REPLAY_WINDOW_SECONDS_DEFAULT,
  INSTANT_REPLAY_WINDOW_SECONDS_MAX,
  INSTANT_REPLAY_WINDOW_SECONDS_MIN,
  normalizeInstantReplayWindowSeconds,
} from "../shared/instant-replay-window";

/** Per-provider upload folder so switching providers does not overwrite paths. */
export interface ProviderFolderSettings {
  folderInput: string;
  folderId: string | null;
  folderPath: string[];
}

export interface UploadSettingsStore extends PrivacyRedactionSettings {
  activeStorageProvider: StorageProviderId;
  /** Active provider's folder (mirrors folderByProvider[active]). */
  folderInput: string;
  folderId: string | null;
  folderPath: string[];
  /**
   * Folder settings keyed by provider. When the user switches active provider,
   * the previous folder is kept here and the new provider's folder is restored.
   */
  folderByProvider: Partial<Record<StorageProviderId, ProviderFolderSettings>>;
  zipPassword: string;
  /** Empty means the browser's default microphone. */
  microphoneDeviceId: string;
  /** Empty means no system/loopback audio input is selected. */
  speakerDeviceId: string;
  captureConsole: boolean;
  captureConsoleArgs: boolean;
  consolePreviewDepth: ConsolePreviewDepth;
  captureConsoleStacks: ConsoleStackMode;
  captureConsoleSourceSnippets: ConsoleSourceSnippetMode;
  maxConsoleEntryBytes: number | null;
  captureNetwork: boolean;
  captureRequestHeaders: HeaderCaptureMode;
  captureResponseHeaders: HeaderCaptureMode;
  captureRequestBodies: boolean;
  captureResponseBodies: boolean;
  captureResponseBodyMode: ResponseBodyCaptureMode;
  maxResponseBodyBytes: number | null;
  captureRedirectHeaders: RedirectHeaderCaptureMode;
  captureInitiator: InitiatorCaptureMode;
  suppressRecorderInternalRequests: boolean;
  captureWebSockets: boolean;
  captureWebSocketFrames: boolean;
  maxWebSocketFrameBytes: number | null;
  captureWebSocketInitiator: boolean;
  // Inspector capture: on by default for full recording; redaction companions stay on.
  captureStorage: boolean;
  redactStorageValues: boolean;
  captureDomSnapshots: boolean;
  redactDomTextContent: boolean;
  /**
   * Always-on Instant Replay (jam-style). When true, a content script keeps a
   * rolling DOM lookback on browsed pages. Capture packages the buffer after
   * the bug — no Start/Stop recording session.
   */
  instantReplayEnabled: boolean;
  /** Rolling lookback window for the always-on Instant Replay buffer (seconds). */
  instantReplayWindowSeconds: number;
  /** Hosts where IR may attach chrome.debugger for console/network lookback. */
  instantReplayAllowedDomains: string[];
}

interface PersistedPopupState extends PopupState {}

export const STORAGE_KEY_STATE = "gn_tracing_state";
const STORAGE_KEY_SETTINGS = "gn_tracing_upload_settings";
const STORAGE_KEY_HISTORY = "gn_tracing_upload_history";
const DEFAULT_UPLOAD_FOLDER_INPUT = "/gn-tracing";
export const MAX_UPLOAD_HISTORY_ITEMS = 100;
const DEFAULT_UPLOAD_FOLDER = parseGoogleDriveFolderInput(DEFAULT_UPLOAD_FOLDER_INPUT);
/** Fixed non-UI privacy profile for redaction rule membership + privacy.json. */
export const DEFAULT_PRIVACY_REDACTION_SETTINGS = getPrivacyProfileSettings("custom");
export const DEFAULT_CAPTURE_PRIVACY_SETTINGS = {
  ...DEFAULT_PRIVACY_REDACTION_SETTINGS,
  captureConsole: true,
  captureConsoleArgs: true,
  consolePreviewDepth: "full" as ConsolePreviewDepth,
  captureConsoleStacks: "all" as ConsoleStackMode,
  captureConsoleSourceSnippets: "all" as ConsoleSourceSnippetMode,
  maxConsoleEntryBytes: null,
  captureNetwork: true,
  captureRequestHeaders: "full" as HeaderCaptureMode,
  captureResponseHeaders: "full" as HeaderCaptureMode,
  captureRequestBodies: true,
  captureResponseBodies: true,
  captureResponseBodyMode: "eligible" as ResponseBodyCaptureMode,
  maxResponseBodyBytes: null,
  captureRedirectHeaders: "full" as RedirectHeaderCaptureMode,
  captureInitiator: "full-stack" as InitiatorCaptureMode,
  suppressRecorderInternalRequests: true,
  captureWebSockets: true,
  captureWebSocketFrames: true,
  maxWebSocketFrameBytes: null,
  captureWebSocketInitiator: true,
  microphoneDeviceId: "",
  speakerDeviceId: "",
  // Full recording defaults: inspector surfaces on; redaction companions stay on.
  captureStorage: true,
  redactStorageValues: true,
  captureDomSnapshots: true,
  redactDomTextContent: true,
  instantReplayEnabled: false,
  instantReplayWindowSeconds: INSTANT_REPLAY_WINDOW_SECONDS_DEFAULT,
  instantReplayAllowedDomains: [] as string[],
};

const DEFAULT_GOOGLE_FOLDER: ProviderFolderSettings = {
  folderInput: DEFAULT_UPLOAD_FOLDER.normalizedInput,
  folderId: DEFAULT_UPLOAD_FOLDER.folderId,
  folderPath: [...DEFAULT_UPLOAD_FOLDER.folderPath],
};
const DEFAULT_DROPBOX_FOLDER: ProviderFolderSettings = {
  folderInput: parseDropboxFolderInput(DEFAULT_UPLOAD_FOLDER_INPUT).normalizedInput,
  folderId: null,
  folderPath: [...parseDropboxFolderInput(DEFAULT_UPLOAD_FOLDER_INPUT).folderPath],
};

let cachedUploadSettings: UploadSettingsStore = {
  activeStorageProvider: "google-drive",
  folderInput: DEFAULT_GOOGLE_FOLDER.folderInput,
  folderId: DEFAULT_GOOGLE_FOLDER.folderId,
  folderPath: [...DEFAULT_GOOGLE_FOLDER.folderPath],
  folderByProvider: {
    "google-drive": {
      ...DEFAULT_GOOGLE_FOLDER,
      folderPath: [...DEFAULT_GOOGLE_FOLDER.folderPath],
    },
    dropbox: {
      ...DEFAULT_DROPBOX_FOLDER,
      folderPath: [...DEFAULT_DROPBOX_FOLDER.folderPath],
    },
  },
  zipPassword: "",
  ...DEFAULT_CAPTURE_PRIVACY_SETTINGS,
};
let hasLoadedUploadSettings = false;
let cachedUploadHistory: UploadHistoryEntry[] = [];
let hasLoadedUploadHistory = false;

export function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function normalizeOptionalNumber(
  value: unknown,
  fallback: number | null,
  min: number,
  max: number,
): number | null {
  if (value === undefined) {
    return fallback;
  }
  // Null or an empty string means the user intentionally left the setting blank, disabling the size limit.
  if (value === null || value === "") {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function normalizeEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/**
 * Providers registered for connect/upload in this build (Drive + Dropbox).
 */
const ACTIVE_STORAGE_PROVIDERS = [
  "google-drive",
  "dropbox",
] as const satisfies readonly StorageProviderId[];

/** @deprecated Prefer clampActiveStorageProvider — kept as alias for older imports/tests. */
export function clampActiveStorageProviderP0(value: unknown): StorageProviderId {
  return clampActiveStorageProvider(value);
}

export function clampActiveStorageProvider(value: unknown): StorageProviderId {
  const normalized = normalizeStorageProviderId(value, "google-drive");
  return (ACTIVE_STORAGE_PROVIDERS as readonly string[]).includes(normalized)
    ? normalized
    : "google-drive";
}

/** Parse folder input for the given provider (Drive ids/links vs path-based clouds). */
export function parseFolderInputForProvider(
  provider: StorageProviderId,
  input: string | null | undefined,
): ProviderFolderSettings {
  if (provider === "dropbox") {
    const parsed = parseDropboxFolderInput(input);
    return {
      folderInput: parsed.normalizedInput,
      folderId: parsed.folderId,
      folderPath: [...parsed.folderPath],
    };
  }
  const parsed = parseGoogleDriveFolderInput(input);
  return {
    folderInput: parsed.normalizedInput,
    folderId: parsed.folderId,
    folderPath: [...parsed.folderPath],
  };
}

function normalizeProviderFolderSettings(
  provider: StorageProviderId,
  stored: Partial<ProviderFolderSettings> | undefined,
  fallback: ProviderFolderSettings,
): ProviderFolderSettings {
  if (!stored || typeof stored !== "object") {
    return {
      folderInput: fallback.folderInput,
      folderId: fallback.folderId,
      folderPath: [...fallback.folderPath],
    };
  }
  if (typeof stored.folderInput === "string") {
    const parsed = parseFolderInputForProvider(provider, stored.folderInput);
    return {
      folderInput: parsed.folderInput,
      folderId: typeof stored.folderId === "string" ? stored.folderId : parsed.folderId,
      folderPath: Array.isArray(stored.folderPath)
        ? stored.folderPath.filter((segment) => typeof segment === "string")
        : parsed.folderPath,
    };
  }
  return {
    folderInput: fallback.folderInput,
    folderId: typeof stored.folderId === "string" ? stored.folderId : fallback.folderId,
    folderPath: Array.isArray(stored.folderPath)
      ? stored.folderPath.filter((segment) => typeof segment === "string")
      : [...fallback.folderPath],
  };
}

function normalizeUploadSettingsStore(
  stored: Partial<UploadSettingsStore> | Partial<UploadSettings> | undefined,
): UploadSettingsStore {
  const storedUploadSettings = stored as Partial<UploadSettingsStore> | undefined;
  // Active providers: google-drive + dropbox. Unknown (incl. legacy onedrive) clamp to Drive.
  const activeStorageProvider = clampActiveStorageProvider(
    storedUploadSettings?.activeStorageProvider,
  );

  const storedByProvider =
    storedUploadSettings?.folderByProvider &&
    typeof storedUploadSettings.folderByProvider === "object"
      ? storedUploadSettings.folderByProvider
      : {};

  const googleFolder = normalizeProviderFolderSettings(
    "google-drive",
    storedByProvider["google-drive"] ??
      (activeStorageProvider === "google-drive" || !storedByProvider.dropbox
        ? {
            folderInput: typeof stored?.folderInput === "string" ? stored.folderInput : undefined,
            folderId: typeof stored?.folderId === "string" ? stored.folderId : undefined,
            folderPath: Array.isArray(storedUploadSettings?.folderPath)
              ? storedUploadSettings.folderPath
              : undefined,
          }
        : undefined),
    DEFAULT_GOOGLE_FOLDER,
  );
  const dropboxFolder = normalizeProviderFolderSettings(
    "dropbox",
    storedByProvider.dropbox ??
      (activeStorageProvider === "dropbox"
        ? {
            folderInput: typeof stored?.folderInput === "string" ? stored.folderInput : undefined,
            folderId: typeof stored?.folderId === "string" ? stored.folderId : undefined,
            folderPath: Array.isArray(storedUploadSettings?.folderPath)
              ? storedUploadSettings.folderPath
              : undefined,
          }
        : undefined),
    DEFAULT_DROPBOX_FOLDER,
  );

  const folderByProvider: Partial<Record<StorageProviderId, ProviderFolderSettings>> = {
    "google-drive": googleFolder,
    dropbox: dropboxFolder,
  };
  const activeFolder = activeStorageProvider === "dropbox" ? dropboxFolder : googleFolder;

  // Field-level fallbacks only — legacy captureProfile / privacyProfile keys are ignored
  // so missing fields never re-apply lean/balanced/strict preset bundles.
  const defaults = DEFAULT_CAPTURE_PRIVACY_SETTINGS;
  const privacyDefaults = DEFAULT_PRIVACY_REDACTION_SETTINGS;

  // Coupling (product rule): when network/request capture is on, storage and
  // DOM snapshot capture are forced on too. Redaction toggles stay independent.
  const captureNetwork = normalizeBoolean(
    storedUploadSettings?.captureNetwork,
    defaults.captureNetwork,
  );

  return {
    activeStorageProvider,
    folderInput: activeFolder.folderInput,
    folderId: activeFolder.folderId,
    folderPath: [...activeFolder.folderPath],
    folderByProvider,
    zipPassword:
      typeof storedUploadSettings?.zipPassword === "string" ? storedUploadSettings.zipPassword : "",
    microphoneDeviceId:
      typeof storedUploadSettings?.microphoneDeviceId === "string"
        ? storedUploadSettings.microphoneDeviceId
        : defaults.microphoneDeviceId,
    speakerDeviceId:
      typeof storedUploadSettings?.speakerDeviceId === "string"
        ? storedUploadSettings.speakerDeviceId
        : defaults.speakerDeviceId,
    // Always "custom" for redaction rule membership (standard-class rules when toggles on).
    privacyProfile: "custom",
    redactSensitiveHeaders: normalizeBoolean(
      storedUploadSettings?.redactSensitiveHeaders,
      privacyDefaults.redactSensitiveHeaders,
    ),
    redactSensitiveQueryParams: normalizeBoolean(
      storedUploadSettings?.redactSensitiveQueryParams,
      privacyDefaults.redactSensitiveQueryParams,
    ),
    redactRequestBodyFields: normalizeBoolean(
      storedUploadSettings?.redactRequestBodyFields,
      privacyDefaults.redactRequestBodyFields,
    ),
    redactResponseBodyFields: normalizeBoolean(
      storedUploadSettings?.redactResponseBodyFields,
      privacyDefaults.redactResponseBodyFields,
    ),
    redactConsoleValues: normalizeBoolean(
      storedUploadSettings?.redactConsoleValues,
      privacyDefaults.redactConsoleValues,
    ),
    redactWebSocketPayloads: normalizeEnum(
      storedUploadSettings?.redactWebSocketPayloads,
      ["off", "sensitive-fields", "all"],
      privacyDefaults.redactWebSocketPayloads,
    ),
    redactEventMetadata: normalizeBoolean(
      storedUploadSettings?.redactEventMetadata,
      privacyDefaults.redactEventMetadata,
    ),
    maskDomSelectors: normalizeMaskDomSelectors(storedUploadSettings?.maskDomSelectors),
    captureConsole: normalizeBoolean(storedUploadSettings?.captureConsole, defaults.captureConsole),
    captureConsoleArgs: normalizeBoolean(
      storedUploadSettings?.captureConsoleArgs,
      defaults.captureConsoleArgs,
    ),
    consolePreviewDepth: normalizeEnum<ConsolePreviewDepth>(
      storedUploadSettings?.consolePreviewDepth,
      ["none", "shallow", "full"],
      defaults.consolePreviewDepth,
    ),
    captureConsoleStacks: normalizeEnum<ConsoleStackMode>(
      storedUploadSettings?.captureConsoleStacks,
      ["off", "errors", "warnings-errors", "all"],
      defaults.captureConsoleStacks,
    ),
    captureConsoleSourceSnippets: normalizeEnum<ConsoleSourceSnippetMode>(
      storedUploadSettings?.captureConsoleSourceSnippets,
      ["off", "errors", "warnings-errors", "all"],
      defaults.captureConsoleSourceSnippets,
    ),
    maxConsoleEntryBytes: normalizeOptionalNumber(
      storedUploadSettings?.maxConsoleEntryBytes,
      defaults.maxConsoleEntryBytes,
      1024,
      512 * 1024,
    ),
    captureNetwork,
    captureRequestHeaders: normalizeEnum<HeaderCaptureMode>(
      storedUploadSettings?.captureRequestHeaders,
      ["off", "minimal", "full"],
      defaults.captureRequestHeaders,
    ),
    captureResponseHeaders: normalizeEnum<HeaderCaptureMode>(
      storedUploadSettings?.captureResponseHeaders,
      ["off", "minimal", "full"],
      defaults.captureResponseHeaders,
    ),
    captureRequestBodies: normalizeBoolean(
      stored?.captureRequestBodies,
      defaults.captureRequestBodies,
    ),
    captureResponseBodies: normalizeBoolean(
      stored?.captureResponseBodies,
      defaults.captureResponseBodies,
    ),
    captureResponseBodyMode: normalizeEnum<ResponseBodyCaptureMode>(
      storedUploadSettings?.captureResponseBodyMode,
      ["off", "text", "text-json", "eligible"],
      normalizeBoolean(stored?.captureResponseBodies, defaults.captureResponseBodies)
        ? defaults.captureResponseBodyMode
        : "off",
    ),
    maxResponseBodyBytes: normalizeOptionalNumber(
      storedUploadSettings?.maxResponseBodyBytes,
      defaults.maxResponseBodyBytes,
      0,
      10 * 1024 * 1024,
    ),
    captureRedirectHeaders: normalizeEnum<RedirectHeaderCaptureMode>(
      storedUploadSettings?.captureRedirectHeaders,
      ["off", "location", "full"],
      defaults.captureRedirectHeaders,
    ),
    captureInitiator: normalizeEnum<InitiatorCaptureMode>(
      storedUploadSettings?.captureInitiator,
      ["off", "summary", "short-stack", "full-stack"],
      defaults.captureInitiator,
    ),
    suppressRecorderInternalRequests: normalizeBoolean(
      storedUploadSettings?.suppressRecorderInternalRequests,
      defaults.suppressRecorderInternalRequests,
    ),
    captureWebSockets: normalizeBoolean(
      storedUploadSettings?.captureWebSockets,
      defaults.captureWebSockets,
    ),
    captureWebSocketFrames: normalizeBoolean(
      stored?.captureWebSocketFrames,
      defaults.captureWebSocketFrames,
    ),
    maxWebSocketFrameBytes: normalizeOptionalNumber(
      storedUploadSettings?.maxWebSocketFrameBytes,
      defaults.maxWebSocketFrameBytes,
      0,
      1024 * 1024,
    ),
    captureWebSocketInitiator: normalizeBoolean(
      storedUploadSettings?.captureWebSocketInitiator,
      defaults.captureWebSocketInitiator,
    ),
    captureStorage:
      normalizeBoolean(storedUploadSettings?.captureStorage, defaults.captureStorage) ||
      captureNetwork,
    redactStorageValues: normalizeBoolean(
      storedUploadSettings?.redactStorageValues,
      defaults.redactStorageValues,
    ),
    captureDomSnapshots:
      normalizeBoolean(storedUploadSettings?.captureDomSnapshots, defaults.captureDomSnapshots) ||
      captureNetwork,
    redactDomTextContent: normalizeBoolean(
      storedUploadSettings?.redactDomTextContent,
      defaults.redactDomTextContent,
    ),
    instantReplayEnabled: normalizeBoolean(
      storedUploadSettings?.instantReplayEnabled,
      defaults.instantReplayEnabled,
    ),
    instantReplayWindowSeconds: normalizeInstantReplayWindowSeconds(
      storedUploadSettings?.instantReplayWindowSeconds,
      defaults.instantReplayWindowSeconds,
    ),
    instantReplayAllowedDomains: normalizeInstantReplayAllowedDomains(
      storedUploadSettings?.instantReplayAllowedDomains ?? defaults.instantReplayAllowedDomains,
    ),
    // Legacy `captureMode` (cdp | in-page) is ignored: Record is CDP-only.
  };
}

export async function getUploadSettings(): Promise<UploadSettingsStore> {
  if (hasLoadedUploadSettings) {
    return cachedUploadSettings;
  }

  try {
    const result = await chrome.storage.local.get(STORAGE_KEY_SETTINGS);
    let stored = result[STORAGE_KEY_SETTINGS] as Partial<UploadSettingsStore> | undefined;
    let shouldBackfillLocalSettings = false;

    if (!stored) {
      const persistedState = await loadPersistedPopupState();
      stored = persistedState?.settings;
      shouldBackfillLocalSettings = Boolean(stored);
    }

    cachedUploadSettings = normalizeUploadSettingsStore(stored);

    if (shouldBackfillLocalSettings) {
      await chrome.storage.local.set({
        [STORAGE_KEY_SETTINGS]: cachedUploadSettings,
      });
    }
  } catch {
    cachedUploadSettings = normalizeUploadSettingsStore(undefined);
  }

  hasLoadedUploadSettings = true;
  return cachedUploadSettings;
}

export async function saveUploadSettings(settings: UploadSettingsStore): Promise<void> {
  cachedUploadSettings = settings;
  hasLoadedUploadSettings = true;
  await chrome.storage.local.set({ [STORAGE_KEY_SETTINGS]: settings });
}

export async function getUploadHistory(): Promise<UploadHistoryEntry[]> {
  if (hasLoadedUploadHistory) {
    return cachedUploadHistory;
  }

  try {
    const result = await chrome.storage.local.get(STORAGE_KEY_HISTORY);
    const history = result[STORAGE_KEY_HISTORY];
    cachedUploadHistory = Array.isArray(history)
      ? sortUploadHistory((history as UploadHistoryEntry[]).map(normalizeUploadHistoryEntry))
      : [];
  } catch {
    cachedUploadHistory = [];
  }

  hasLoadedUploadHistory = true;
  return cachedUploadHistory;
}

export async function saveUploadHistory(history: UploadHistoryEntry[]): Promise<void> {
  cachedUploadHistory = sortUploadHistory(history).slice(0, MAX_UPLOAD_HISTORY_ITEMS);
  hasLoadedUploadHistory = true;
  await chrome.storage.local.set({
    [STORAGE_KEY_HISTORY]: cachedUploadHistory,
  });
}

export function getSettingsSnapshot(settings: UploadSettingsStore): UploadSettings {
  return {
    activeStorageProvider: settings.activeStorageProvider,
    folderInput: settings.folderInput,
    folderId: settings.folderId,
    zipPasswordConfigured: settings.zipPassword.length > 0,
    microphoneDeviceId: settings.microphoneDeviceId,
    speakerDeviceId: settings.speakerDeviceId,
    privacyProfile: settings.privacyProfile,
    redactSensitiveHeaders: settings.redactSensitiveHeaders,
    redactSensitiveQueryParams: settings.redactSensitiveQueryParams,
    redactRequestBodyFields: settings.redactRequestBodyFields,
    redactResponseBodyFields: settings.redactResponseBodyFields,
    redactConsoleValues: settings.redactConsoleValues,
    redactWebSocketPayloads: settings.redactWebSocketPayloads,
    redactEventMetadata: settings.redactEventMetadata,
    maskDomSelectors: settings.maskDomSelectors,
    captureConsole: settings.captureConsole,
    captureConsoleArgs: settings.captureConsoleArgs,
    consolePreviewDepth: settings.consolePreviewDepth,
    captureConsoleStacks: settings.captureConsoleStacks,
    captureConsoleSourceSnippets: settings.captureConsoleSourceSnippets,
    maxConsoleEntryBytes: settings.maxConsoleEntryBytes,
    captureNetwork: settings.captureNetwork,
    captureRequestHeaders: settings.captureRequestHeaders,
    captureResponseHeaders: settings.captureResponseHeaders,
    captureRequestBodies: settings.captureRequestBodies,
    captureResponseBodies: settings.captureResponseBodies,
    captureResponseBodyMode: settings.captureResponseBodyMode,
    maxResponseBodyBytes: settings.maxResponseBodyBytes,
    captureRedirectHeaders: settings.captureRedirectHeaders,
    captureInitiator: settings.captureInitiator,
    suppressRecorderInternalRequests: settings.suppressRecorderInternalRequests,
    captureWebSockets: settings.captureWebSockets,
    captureWebSocketFrames: settings.captureWebSocketFrames,
    maxWebSocketFrameBytes: settings.maxWebSocketFrameBytes,
    captureWebSocketInitiator: settings.captureWebSocketInitiator,
    captureStorage: settings.captureStorage,
    redactStorageValues: settings.redactStorageValues,
    captureDomSnapshots: settings.captureDomSnapshots,
    redactDomTextContent: settings.redactDomTextContent,
    instantReplayEnabled: settings.instantReplayEnabled,
    instantReplayWindowSeconds: settings.instantReplayWindowSeconds,
    instantReplayAllowedDomains: [...settings.instantReplayAllowedDomains],
  };
}

export async function loadPersistedPopupState(): Promise<PersistedPopupState | null> {
  try {
    const result = await chrome.storage.session.get(STORAGE_KEY_STATE);
    return (result[STORAGE_KEY_STATE] as PersistedPopupState | undefined) || null;
  } catch {
    return null;
  }
}

function sortUploadHistory(items: UploadHistoryEntry[]): UploadHistoryEntry[] {
  return [...items].sort((left, right) => (right.uploadedAt || 0) - (left.uploadedAt || 0));
}

/**
 * Normalize history / upload recording URLs to the external player host.
 * Legacy chrome-extension://…/player/player.html links (from older builds that
 * shipped an in-extension player) are rewritten to namespaced hosted URLs.
 *
 * Development builds also rewrite production player origins onto the baked
 * local player host so Instant Replay / screenshot annotate return and open
 * the dev player (not tracing.gnas.dev).
 */
export function normalizeRecordingUrl(recordingUrl: string | null | undefined): string | null {
  if (!recordingUrl) {
    return null;
  }

  try {
    const parsed = new URL(recordingUrl);
    const ref = parseStorageRecordingRef(parsed);
    let normalized = recordingUrl;
    if (
      parsed.protocol === "chrome-extension:" ||
      parsed.pathname.endsWith("/player/player.html")
    ) {
      if (ref) {
        normalized = buildExternalPlayerUrl(ref.fileId, ref.provider);
      }
    } else if (
      parsed.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(parsed.hostname)
    ) {
      if (ref) {
        normalized = buildExternalPlayerUrl(ref.fileId, ref.provider);
      }
    }
    // Development-only: map production hosts → local player (no-op in production).
    return resolveReplayOpenUrl(normalized) || normalized;
  } catch {
    return resolveReplayOpenUrl(recordingUrl) || recordingUrl;
  }
}

export function normalizeUploadHistoryEntry(entry: UploadHistoryEntry): UploadHistoryEntry {
  return {
    ...entry,
    recordingUrl: normalizeRecordingUrl(entry.recordingUrl) || entry.recordingUrl,
  };
}

export function pickPrivacyRedactionSettings(
  settings: PrivacyRedactionSettings,
): PrivacyRedactionSettings {
  return {
    privacyProfile: settings.privacyProfile,
    redactSensitiveHeaders: settings.redactSensitiveHeaders,
    redactSensitiveQueryParams: settings.redactSensitiveQueryParams,
    redactRequestBodyFields: settings.redactRequestBodyFields,
    redactResponseBodyFields: settings.redactResponseBodyFields,
    redactConsoleValues: settings.redactConsoleValues,
    redactWebSocketPayloads: settings.redactWebSocketPayloads,
    redactEventMetadata: settings.redactEventMetadata,
    maskDomSelectors: [...settings.maskDomSelectors],
  };
}
