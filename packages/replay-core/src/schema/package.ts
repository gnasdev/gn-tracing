/**
 * Package-level schema: the artifact taxonomy and the three index documents
 * (`metadata.json`, `manifest.json`, `recording-index.json`).
 *
 * This file is the single source of truth for artifact filenames. Before it
 * existed the same table was spelled out twice — once in the reader and once in
 * the extension packager — so adding an artifact meant remembering to edit a
 * file in a different tree. Both sides now import from here.
 *
 * The models stay structural and permissive: this library reads packages
 * produced by *any* shipped version, so it must not reject a payload for
 * carrying an unknown field.
 */

/** Logical artifact ids, independent of the on-disk filename. */
export type ArtifactId =
  | "metadata"
  | "manifest"
  | "index"
  | "console"
  | "network"
  | "websocket"
  | "report"
  | "events"
  | "drawing"
  | "privacy"
  | "diagnostics"
  | "storage"
  | "dom"
  | "screenshot"
  | "screenshots"
  | "instantReplay"
  | "agentSummary";

/** Conventional on-disk filename per artifact, used when no index maps it. */
export const ARTIFACT_FILENAMES: Record<ArtifactId, string> = {
  metadata: "metadata.json",
  manifest: "manifest.json",
  index: "recording-index.json",
  console: "console.json",
  network: "network.json",
  websocket: "websocket.json",
  report: "report.json",
  events: "events.json",
  drawing: "drawing.json",
  privacy: "privacy.json",
  diagnostics: "diagnostics.json",
  storage: "storage.json",
  dom: "dom.json",
  // `screenshot` is the single auto-captured image written at stop time since
  // v1; `screenshots` is the annotated set a reporter captures on purpose. Both
  // exist because dropping the old id would make every shipped package's
  // screenshot unreadable.
  screenshot: "screenshot.jpg",
  screenshots: "screenshots.json",
  instantReplay: "instant-replay.json",
  agentSummary: "agent-summary.json",
};

/**
 * `recording-index.json` spells artifact keys with a `Path` suffix, while
 * `manifest.json` uses the bare `ArtifactId`. `metadata`, `manifest`, and
 * `index` are absent because the index cannot reference itself or the two
 * documents whose paths it already carries as dedicated fields.
 */
export const ARTIFACT_INDEX_KEYS: Partial<Record<ArtifactId, string>> = {
  console: "consolePath",
  network: "networkPath",
  websocket: "websocketPath",
  report: "reportPath",
  events: "eventsPath",
  drawing: "drawingPath",
  privacy: "privacyPath",
  diagnostics: "diagnosticsPath",
  storage: "storagePath",
  dom: "domPath",
  screenshot: "screenshotPath",
  screenshots: "screenshotsPath",
  instantReplay: "instantReplayPath",
  agentSummary: "agentSummaryPath",
};

/**
 * Artifacts a producer may attach to a package. The three index documents are
 * excluded: they are written unconditionally and describe the rest.
 */
export type AttachableArtifactId = Exclude<ArtifactId, "metadata" | "manifest" | "index">;

export const ATTACHABLE_ARTIFACT_IDS = Object.keys(ARTIFACT_FILENAMES).filter(
  (id): id is AttachableArtifactId => id !== "metadata" && id !== "manifest" && id !== "index",
);

/** Which tool wrote the package. Absent on packages predating the field. */
export type RecordingProducer = "extension" | "sdk";

/**
 * What a producer was actually able to capture.
 *
 * Consumers must branch on this rather than on the presence of an artifact: an
 * absent `console.json` because the SDK could not capture console output and an
 * absent one because the user recorded a silent session are different facts,
 * and only the capability list distinguishes them. Unknown strings are allowed
 * so an older reader tolerates a newer producer.
 */
export type RecordingCapability =
  | "video"
  | "console"
  | "network"
  | "network-bodies"
  | "websocket"
  | "user-events"
  | "storage"
  | "cookies"
  | "dom-snapshot"
  | "source-maps"
  | "cross-origin"
  /** Can produce a raster screenshot of the page. */
  | "screenshot"
  /** Can attach reporter-drawn shapes to a screenshot. */
  | "annotation"
  /** Keeps a rolling pre-bug buffer, so the bug need not be reproduced. */
  | "instant-replay";

/** Transport or browser API that supplied a normalized evidence surface. */
export type EvidenceSource =
  | "cdp"
  | "firefox-rdp"
  | "webdriver-bidi"
  | "webkit-inspector"
  | "web-request"
  | "in-page";

/** Independently selectable units of evidence, finer-grained than artifacts. */
export type EvidenceSurface =
  | "console-api"
  | "runtime-exception"
  | "runtime-object-details"
  | "network-lifecycle"
  | "network-request-headers"
  | "network-response-headers"
  | "network-response-body"
  | "network-initiator"
  | "network-timing"
  | "websocket-lifecycle"
  | "websocket-frames"
  | "storage-snapshot"
  | "cookie-snapshot"
  | "dom-snapshot"
  | "source-map-resolution";

/** Fidelity of the selected source for one evidence surface. */
export type EvidenceQuality = "full" | "partial";

export interface EvidenceSurfaceCoverage {
  source: EvidenceSource;
  quality: EvidenceQuality;
}

/** Per-session evidence ownership written to package metadata. */
export interface EvidenceCoverage {
  schemaVersion: 1;
  surfaces: Partial<Record<EvidenceSurface, EvidenceSurfaceCoverage>>;
}

/** Everything the tab-capture extension can record. */
export const EXTENSION_CAPABILITIES: RecordingCapability[] = [
  "video",
  "console",
  "network",
  "network-bodies",
  "websocket",
  "user-events",
  "storage",
  "cookies",
  "dom-snapshot",
  "source-maps",
  "cross-origin",
  "screenshot",
  "annotation",
  "instant-replay",
];

/**
 * What an in-page SDK can reach without CDP: no tab video, no cross-origin
 * request detail, and no cookies beyond the embedding document's own.
 *
 * `screenshot` is absent on purpose. The SDK can capture *what the page looked
 * like* as a DOM snapshot, and annotate it, but it cannot rasterise the
 * viewport — no in-page API exposes the rendered pixels, and `getDisplayMedia`
 * does not exist on the mobile browsers this SDK is for. Calling that a
 * screenshot capability would promise a reader an image that is not there.
 */
export const SDK_CAPABILITIES: RecordingCapability[] = [
  "console",
  "network",
  "network-bodies",
  "websocket",
  "user-events",
  "storage",
  "dom-snapshot",
  "annotation",
  "instant-replay",
];

/**
 * Firefox extension producer: in-page console/websocket, webRequest network
 * metadata (no response bodies), optional getDisplayMedia video, raster
 * screenshots, no CDP cross-origin or source maps.
 *
 * No "network-bodies": full-record network is owned by observe-only webRequest,
 * which always stores `responseBody: null`. In-page capture on that path also
 * disables fetch/XHR patches so page-script network rows are not dual-written.
 * Declaring bodies here would tell the player/MCP they exist when none do.
 *
 * Declared here so readers/tests can import without the extension platform
 * package.
 */
export const FIREFOX_EXTENSION_CAPABILITIES: RecordingCapability[] = [
  "video",
  "console",
  "network",
  "websocket",
  "user-events",
  "storage",
  "dom-snapshot",
  "screenshot",
  "annotation",
  "instant-replay",
];

/**
 * macOS Safari extension producer: identical evidence model to Firefox
 * (in-page console/websocket, webRequest network metadata, getDisplayMedia
 * video) — Safari has no CDP either, so it follows the same in-page path.
 */
export const SAFARI_EXTENSION_CAPABILITIES: RecordingCapability[] = [
  ...FIREFOX_EXTENSION_CAPABILITIES,
];

/**
 * iOS/iPadOS Safari extension producer: no "video", no "screenshot" — iOS
 * exposes no screen/tab capture API to extension JS at all (no
 * getDisplayMedia, no ReplayKit bridge). Network is in-page (no webRequest
 * collector on this path), same reasoning `SDK_CAPABILITIES` documents for
 * why screenshot is absent rather than merely degraded.
 */
export const SAFARI_IOS_EXTENSION_CAPABILITIES: RecordingCapability[] = [
  "console",
  "network",
  "websocket",
  "user-events",
  "storage",
  "dom-snapshot",
  "annotation",
  "instant-replay",
];

export interface PackageMetadata {
  timestamp?: string;
  /** Recording duration in milliseconds. */
  duration?: number | null;
  url?: string;
  // The writer emits `null` when a session has no recorded start time, so the
  // reader must accept it; `resolveRecordingStartTime` falls back to `timestamp`.
  startTime?: number | null;
  extension?: string;
  version?: string;
  /** Absent on packages written before producers were distinguished. */
  producer?: RecordingProducer;
  /** Absent on older packages; treat that as `EXTENSION_CAPABILITIES`. */
  capabilities?: RecordingCapability[];
  /** Selected evidence sources and their per-surface fidelity. */
  evidenceCoverage?: EvidenceCoverage;
  storage?: {
    provider?: string;
    folderId?: string | null;
    package?: string;
  };
  video?: {
    mimeType?: string;
    totalBytes?: number;
    partCount?: number;
  };
}

export interface PackageManifest {
  schemaVersion?: number;
  folderId?: string | null;
  video?: {
    mimeType?: string;
    totalBytes?: number;
    parts?: Array<{ name: string; size: number }>;
  };
  artifacts?: Record<string, string | undefined>;
}

export interface RecordingIndex {
  schemaVersion?: number;
  manifestPath?: string;
  metadataPath?: string;
  artifacts?: Record<string, string | undefined>;
  video?: { mimeType?: string; totalBytes?: number; partPaths?: string[] };
}

/**
 * Capabilities to assume for a package that predates the field. Only the
 * extension existed then, so the full set is the honest answer.
 */
export function resolveCapabilities(metadata: PackageMetadata): RecordingCapability[] {
  return metadata.capabilities ?? EXTENSION_CAPABILITIES;
}

/** True when the producer claims it could capture `capability`. */
export function hasCapability(metadata: PackageMetadata, capability: RecordingCapability): boolean {
  return resolveCapabilities(metadata).includes(capability);
}
