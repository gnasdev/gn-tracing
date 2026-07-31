/**
 * Packaging a screenshot / Instant Replay report.
 *
 * Two product paths share this writer (no video, same zip layout):
 * - **Screenshot**: annotated still(s) + optional one-shot `dom.json`. No IR
 *   lookback, no console/network.
 * - **Instant Replay**: still (when available) + DOM lookback + console/network
 *   evidence from the rolling buffer.
 *
 * The redaction step is the reason this lives in the offscreen document rather
 * than in the service worker: destroying pixels needs `OffscreenCanvas`, which
 * an MV3 service worker does not have. Doing it here also means the unredacted
 * bytes never travel any further than they already have.
 */

import { bakeRedactions } from "../../packages/replay-core/src/annotate/raster";
import {
  type Screenshot,
  type ScreenshotArtifact,
  screenshotHasUnbakedRedactions,
} from "../../packages/replay-core/src/schema/annotation";
import type {
  PackageMetadata,
  RecordingCapability,
} from "../../packages/replay-core/src/schema/package";
import {
  type AttachableArtifactId,
  type BuiltPackage,
  buildAgentSummaryArtifact,
  buildRecordingPackage,
  encodeJsonArtifact,
} from "../../packages/replay-core/src/write";
import { getProductVersionOrDefault } from "../shared/app-version";

/** Directory prefix for screenshot images inside the package. */
export const SCREENSHOT_ENTRY_PREFIX = "screenshots/";

export interface ScreenshotInput {
  screenshot: Screenshot;
  /** Raw capture bytes, still containing whatever the redactions cover. */
  imageBytes: Uint8Array;
  imageMimeType: string;
}

/**
 * Which product path produced the package. Controls default capabilities when
 * the caller does not pass an explicit list.
 */
export type ScreenshotPackageKind = "screenshot" | "instant-replay";

export interface BuildScreenshotPackageInput {
  screenshots: ScreenshotInput[];
  packagedAt: string;
  zipFilename: string;
  url?: string;
  storage?: { provider?: string; folderId?: string | null };
  /** JSON artifacts the service worker already holds, pre-redacted. */
  artifacts?: Partial<Record<AttachableArtifactId, Uint8Array>>;
  password?: string;
  modifiedAt?: Date;
  /**
   * Product path. Defaults to `screenshot` (lean caps). Instant Replay must
   * pass `instant-replay` so the package claims console/network even when the
   * lookback window was quiet.
   */
  packageKind?: ScreenshotPackageKind;
  /** Override capability list; wins over packageKind defaults. */
  capabilities?: RecordingCapability[];
}

/**
 * Lean screenshot report: still + annotations.
 * `dom-snapshot` is added when a one-shot DOM tree ships in `dom.json`.
 * Instant Replay lookback and console/network belong to the IR product path.
 */
export const SCREENSHOT_REPORT_CAPABILITIES: RecordingCapability[] = ["screenshot", "annotation"];

/**
 * Instant Replay report: DOM lookback + log surfaces (even if quiet) + optional still.
 * No tab video — that remains full Record.
 */
export const INSTANT_REPLAY_REPORT_CAPABILITIES: RecordingCapability[] = [
  "screenshot",
  "annotation",
  "instant-replay",
  "dom-snapshot",
  "console",
  "network",
  "network-bodies",
  "websocket",
  "storage",
];

/**
 * Resolve package capabilities for a screenshot/IR package.
 * Callers may override with `input.capabilities`.
 */
export function resolveScreenshotPackageCapabilities(input: {
  packageKind?: ScreenshotPackageKind;
  capabilities?: RecordingCapability[];
  hasScreenshots?: boolean;
  hasInstantReplay?: boolean;
  hasDom?: boolean;
}): RecordingCapability[] {
  if (input.capabilities && input.capabilities.length > 0) {
    return input.capabilities;
  }

  if (input.packageKind === "instant-replay") {
    return [...INSTANT_REPLAY_REPORT_CAPABILITIES];
  }

  // Screenshot: still + optional one-shot DOM. Never IR / console / network.
  const caps: RecordingCapability[] = [...SCREENSHOT_REPORT_CAPABILITIES];
  if (input.hasDom) {
    caps.push("dom-snapshot");
  }
  return caps;
}

export async function buildScreenshotPackage(
  input: BuildScreenshotPackageInput,
): Promise<BuiltPackage> {
  const artifacts: Partial<Record<AttachableArtifactId, Uint8Array>> = { ...input.artifacts };
  const entries: Array<{ name: string; bytes: Uint8Array }> = [];
  const packaged: Screenshot[] = [];

  for (const item of input.screenshots) {
    // Destroy redacted pixels before anything is written. `bakeRedactions`
    // throws rather than passing the original bytes through, so a runtime
    // without canvas fails the report instead of shipping readable regions.
    const baked = await bakeRedactions(item.imageBytes, item.imageMimeType, item.screenshot);

    if (screenshotHasUnbakedRedactions(item.screenshot)) {
      throw new Error(
        `Screenshot ${item.screenshot.id} still has an unapplied redaction after baking; refusing to package it.`,
      );
    }

    const extension = baked.mimeType === "image/png" ? "png" : "jpg";
    const path = `${SCREENSHOT_ENTRY_PREFIX}${item.screenshot.id}.${extension}`;
    entries.push({ name: path, bytes: baked.bytes });
    packaged.push({
      ...item.screenshot,
      source: { kind: "image", path, mimeType: baked.mimeType },
    });
  }

  if (packaged.length > 0) {
    const screenshotArtifact: ScreenshotArtifact = { schemaVersion: 1, screenshots: packaged };
    artifacts.screenshots = encodeJsonArtifact(screenshotArtifact);
  }

  // Screenshot path keeps optional `dom` but drops IR lookback + log artifacts
  // even if a caller accidentally passed them (Instant Replay uses packageKind).
  if (input.packageKind !== "instant-replay" && input.capabilities == null) {
    delete artifacts.instantReplay;
    delete artifacts.console;
    delete artifacts.network;
    delete artifacts.websocket;
    delete artifacts.storage;
  }

  const hasInstantReplay =
    artifacts.instantReplay != null && artifacts.instantReplay.byteLength > 0;
  const hasDom = artifacts.dom != null && artifacts.dom.byteLength > 0;
  const capabilities = resolveScreenshotPackageCapabilities({
    packageKind: input.packageKind,
    capabilities: input.capabilities,
    hasScreenshots: packaged.length > 0,
    hasInstantReplay,
    hasDom,
  });

  const metadataPreview: PackageMetadata = {
    timestamp: input.packagedAt,
    url: input.url,
    producer: "extension",
    capabilities,
  };
  const agentSummary = buildAgentSummaryArtifact({
    metadata: metadataPreview,
    console: artifacts.console,
    network: artifacts.network,
    websocket: artifacts.websocket,
    events: artifacts.events,
    privacy: artifacts.privacy,
    availableArtifacts: ["metadata", ...Object.keys(artifacts)],
    generatedAt: input.packagedAt,
  });
  if (agentSummary) {
    artifacts.agentSummary = agentSummary;
  }

  const built = await buildRecordingPackage({
    producer: "extension",
    capabilities,
    packagedAt: input.packagedAt,
    zipFilename: input.zipFilename,
    version: getProductVersionOrDefault(),
    duration: null,
    url: input.url,
    startTime: input.screenshots[0]?.screenshot.capturedAt ?? null,
    storage: input.storage,
    artifacts,
    password: input.password,
    modifiedAt: input.modifiedAt,
    extraEntries: entries,
  });

  return built;
}
