import { parseGoogleDriveFolderInput } from "../shared/google-drive-folder";
import { buildExternalPlayerUrl } from "../shared/player-host";
import { getPrivacyProfileSettings, normalizeMaskDomSelectors } from "../shared/privacy-redaction";
import type {
  CaptureProfile,
  ConsolePreviewDepth,
  ConsoleSourceSnippetMode,
  ConsoleStackMode,
  HeaderCaptureMode,
  InitiatorCaptureMode,
  PopupState,
  PrivacyProfile,
  PrivacyRedactionSettings,
  RedirectHeaderCaptureMode,
  ResponseBodyCaptureMode,
  UploadHistoryEntry,
  UploadSettings,
} from "../types/messages";

export interface UploadSettingsStore extends PrivacyRedactionSettings {
  folderInput: string;
  folderId: string | null;
  folderPath: string[];
  zipPassword: string;
  captureProfile: CaptureProfile;
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
}

type CaptureSettingsStore = Omit<
  UploadSettingsStore,
  | "folderInput"
  | "folderId"
  | "folderPath"
  | "zipPassword"
  | "captureProfile"
  | keyof PrivacyRedactionSettings
>;

interface PersistedPopupState extends PopupState {}

export const STORAGE_KEY_STATE = "gn_tracing_state";
const STORAGE_KEY_SETTINGS = "gn_tracing_upload_settings";
const STORAGE_KEY_HISTORY = "gn_tracing_upload_history";
const DEFAULT_UPLOAD_FOLDER_INPUT = "/gn-tracing";
export const MAX_UPLOAD_HISTORY_ITEMS = 100;
const DEFAULT_UPLOAD_FOLDER = parseGoogleDriveFolderInput(DEFAULT_UPLOAD_FOLDER_INPUT);
export const DEFAULT_PRIVACY_REDACTION_SETTINGS = getPrivacyProfileSettings("standard");
export const DEFAULT_CAPTURE_PRIVACY_SETTINGS = {
  captureProfile: "full" as CaptureProfile,
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
};

let cachedUploadSettings: UploadSettingsStore = {
  folderInput: DEFAULT_UPLOAD_FOLDER.normalizedInput,
  folderId: DEFAULT_UPLOAD_FOLDER.folderId,
  folderPath: [...DEFAULT_UPLOAD_FOLDER.folderPath],
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

export function getCaptureProfileSettings(profile: CaptureProfile): CaptureSettingsStore {
  if (profile === "lean") {
    return {
      captureConsole: true,
      captureConsoleArgs: false,
      consolePreviewDepth: "none",
      captureConsoleStacks: "errors",
      captureConsoleSourceSnippets: "errors",
      maxConsoleEntryBytes: 16384,
      captureNetwork: true,
      captureRequestHeaders: "minimal",
      captureResponseHeaders: "minimal",
      captureRequestBodies: false,
      captureResponseBodies: false,
      captureResponseBodyMode: "off",
      maxResponseBodyBytes: 0,
      captureRedirectHeaders: "location",
      captureInitiator: "summary",
      suppressRecorderInternalRequests: true,
      captureWebSockets: true,
      captureWebSocketFrames: false,
      maxWebSocketFrameBytes: 0,
      captureWebSocketInitiator: false,
    };
  }

  if (profile === "full") {
    return {
      captureConsole: true,
      captureConsoleArgs: true,
      consolePreviewDepth: "full",
      captureConsoleStacks: "all",
      captureConsoleSourceSnippets: "all",
      maxConsoleEntryBytes: null,
      captureNetwork: true,
      captureRequestHeaders: "full",
      captureResponseHeaders: "full",
      captureRequestBodies: true,
      captureResponseBodies: true,
      captureResponseBodyMode: "eligible",
      maxResponseBodyBytes: null,
      captureRedirectHeaders: "full",
      captureInitiator: "full-stack",
      suppressRecorderInternalRequests: true,
      captureWebSockets: true,
      captureWebSocketFrames: true,
      maxWebSocketFrameBytes: null,
      captureWebSocketInitiator: true,
    };
  }

  return {
    captureConsole: true,
    captureConsoleArgs: true,
    consolePreviewDepth: "shallow",
    captureConsoleStacks: "warnings-errors",
    captureConsoleSourceSnippets: "warnings-errors",
    maxConsoleEntryBytes: 32768,
    captureNetwork: true,
    captureRequestHeaders: "full",
    captureResponseHeaders: "full",
    captureRequestBodies: true,
    captureResponseBodies: true,
    captureResponseBodyMode: "eligible",
    maxResponseBodyBytes: 1024 * 1024,
    captureRedirectHeaders: "location",
    captureInitiator: "summary",
    suppressRecorderInternalRequests: true,
    captureWebSockets: true,
    captureWebSocketFrames: true,
    maxWebSocketFrameBytes: 65536,
    captureWebSocketInitiator: false,
  };
}

function normalizeUploadSettingsStore(
  stored: Partial<UploadSettingsStore> | Partial<UploadSettings> | undefined,
): UploadSettingsStore {
  const storedUploadSettings = stored as Partial<UploadSettingsStore> | undefined;
  const storedHasFolderInput = typeof stored?.folderInput === "string";
  // Only missing folder settings use the default; saved blank values still mean Drive root.
  const parsedFolder = storedHasFolderInput
    ? parseGoogleDriveFolderInput(stored.folderInput)
    : DEFAULT_UPLOAD_FOLDER;
  const captureProfile = normalizeEnum<CaptureProfile>(
    storedUploadSettings?.captureProfile,
    ["lean", "balanced", "full", "custom"],
    DEFAULT_CAPTURE_PRIVACY_SETTINGS.captureProfile,
  );
  const profileDefaults = getCaptureProfileSettings(
    captureProfile === "custom" ? "full" : captureProfile,
  );
  const privacyProfile = normalizeEnum<PrivacyProfile>(
    storedUploadSettings?.privacyProfile,
    ["standard", "strict", "custom"],
    DEFAULT_PRIVACY_REDACTION_SETTINGS.privacyProfile,
  );
  const privacyDefaults = getPrivacyProfileSettings(
    privacyProfile === "custom" ? "standard" : privacyProfile,
  );

  return {
    folderInput: parsedFolder.normalizedInput,
    folderId: typeof stored?.folderId === "string" ? stored.folderId : parsedFolder.folderId,
    folderPath: Array.isArray(storedUploadSettings?.folderPath)
      ? storedUploadSettings.folderPath.filter((segment) => typeof segment === "string")
      : [...parsedFolder.folderPath],
    zipPassword:
      typeof storedUploadSettings?.zipPassword === "string" ? storedUploadSettings.zipPassword : "",
    captureProfile,
    privacyProfile,
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
    captureConsole: normalizeBoolean(
      storedUploadSettings?.captureConsole,
      profileDefaults.captureConsole,
    ),
    captureConsoleArgs: normalizeBoolean(
      storedUploadSettings?.captureConsoleArgs,
      profileDefaults.captureConsoleArgs,
    ),
    consolePreviewDepth: normalizeEnum<ConsolePreviewDepth>(
      storedUploadSettings?.consolePreviewDepth,
      ["none", "shallow", "full"],
      profileDefaults.consolePreviewDepth,
    ),
    captureConsoleStacks: normalizeEnum<ConsoleStackMode>(
      storedUploadSettings?.captureConsoleStacks,
      ["off", "errors", "warnings-errors", "all"],
      profileDefaults.captureConsoleStacks,
    ),
    captureConsoleSourceSnippets: normalizeEnum<ConsoleSourceSnippetMode>(
      storedUploadSettings?.captureConsoleSourceSnippets,
      ["off", "errors", "warnings-errors", "all"],
      profileDefaults.captureConsoleSourceSnippets,
    ),
    maxConsoleEntryBytes: normalizeOptionalNumber(
      storedUploadSettings?.maxConsoleEntryBytes,
      profileDefaults.maxConsoleEntryBytes,
      1024,
      512 * 1024,
    ),
    captureNetwork: normalizeBoolean(
      storedUploadSettings?.captureNetwork,
      profileDefaults.captureNetwork,
    ),
    captureRequestHeaders: normalizeEnum<HeaderCaptureMode>(
      storedUploadSettings?.captureRequestHeaders,
      ["off", "minimal", "full"],
      profileDefaults.captureRequestHeaders,
    ),
    captureResponseHeaders: normalizeEnum<HeaderCaptureMode>(
      storedUploadSettings?.captureResponseHeaders,
      ["off", "minimal", "full"],
      profileDefaults.captureResponseHeaders,
    ),
    captureRequestBodies: normalizeBoolean(
      stored?.captureRequestBodies,
      profileDefaults.captureRequestBodies,
    ),
    captureResponseBodies: normalizeBoolean(
      stored?.captureResponseBodies,
      profileDefaults.captureResponseBodies,
    ),
    captureResponseBodyMode: normalizeEnum<ResponseBodyCaptureMode>(
      storedUploadSettings?.captureResponseBodyMode,
      ["off", "text", "text-json", "eligible"],
      normalizeBoolean(stored?.captureResponseBodies, profileDefaults.captureResponseBodies)
        ? profileDefaults.captureResponseBodyMode
        : "off",
    ),
    maxResponseBodyBytes: normalizeOptionalNumber(
      storedUploadSettings?.maxResponseBodyBytes,
      profileDefaults.maxResponseBodyBytes,
      0,
      10 * 1024 * 1024,
    ),
    captureRedirectHeaders: normalizeEnum<RedirectHeaderCaptureMode>(
      storedUploadSettings?.captureRedirectHeaders,
      ["off", "location", "full"],
      profileDefaults.captureRedirectHeaders,
    ),
    captureInitiator: normalizeEnum<InitiatorCaptureMode>(
      storedUploadSettings?.captureInitiator,
      ["off", "summary", "short-stack", "full-stack"],
      profileDefaults.captureInitiator,
    ),
    suppressRecorderInternalRequests: normalizeBoolean(
      storedUploadSettings?.suppressRecorderInternalRequests,
      profileDefaults.suppressRecorderInternalRequests,
    ),
    captureWebSockets: normalizeBoolean(
      storedUploadSettings?.captureWebSockets,
      profileDefaults.captureWebSockets,
    ),
    captureWebSocketFrames: normalizeBoolean(
      stored?.captureWebSocketFrames,
      profileDefaults.captureWebSocketFrames,
    ),
    maxWebSocketFrameBytes: normalizeOptionalNumber(
      storedUploadSettings?.maxWebSocketFrameBytes,
      profileDefaults.maxWebSocketFrameBytes,
      0,
      1024 * 1024,
    ),
    captureWebSocketInitiator: normalizeBoolean(
      storedUploadSettings?.captureWebSocketInitiator,
      profileDefaults.captureWebSocketInitiator,
    ),
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
      await chrome.storage.local.set({ [STORAGE_KEY_SETTINGS]: cachedUploadSettings });
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
    folderInput: settings.folderInput,
    folderId: settings.folderId,
    zipPasswordConfigured: settings.zipPassword.length > 0,
    captureProfile: settings.captureProfile,
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

export function normalizeRecordingUrl(recordingUrl: string | null | undefined): string | null {
  if (!recordingUrl) {
    return null;
  }

  try {
    const parsed = new URL(recordingUrl);
    const legacyRecordingId = getLegacyRecordingIdFromUrl(parsed);
    if (
      parsed.protocol === "chrome-extension:" ||
      parsed.pathname.endsWith("/player/player.html")
    ) {
      if (legacyRecordingId) {
        return buildExternalPlayerUrl(legacyRecordingId);
      }
    }
    if (parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname)) {
      if (legacyRecordingId) {
        return buildExternalPlayerUrl(legacyRecordingId);
      }
    }
    return recordingUrl;
  } catch {
    return recordingUrl;
  }
}

function getLegacyRecordingIdFromUrl(parsed: URL): string | null {
  const queryId = parsed.searchParams.get("id");
  if (queryId) {
    return queryId;
  }

  const firstPathSegment = parsed.pathname.split("/").filter(Boolean)[0];
  if (!firstPathSegment || firstPathSegment.endsWith(".html")) {
    return null;
  }

  try {
    return decodeURIComponent(firstPathSegment);
  } catch {
    return firstPathSegment;
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
