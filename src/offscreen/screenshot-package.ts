/**
 * Packaging a screenshot report.
 *
 * A screenshot report is a recording package with no video: one or more
 * annotated images, whatever the instant-replay buffer was holding, and the
 * console/network context the service worker had at capture time. It goes
 * through the same writer as a full recording, so the player and the MCP tools
 * read it with no special case.
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
import {
  EXTENSION_CAPABILITIES,
  type PackageMetadata,
  type RecordingCapability,
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
}

/**
 * Capabilities of a screenshot report: everything the extension can normally do
 * *minus* video, because a screenshot report has none. Claiming `video` here
 * would make the player treat a missing video as a broken package.
 */
export const SCREENSHOT_REPORT_CAPABILITIES: RecordingCapability[] = EXTENSION_CAPABILITIES.filter(
  (capability) => capability !== "video",
);

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

  const screenshotArtifact: ScreenshotArtifact = { schemaVersion: 1, screenshots: packaged };
  artifacts.screenshots = encodeJsonArtifact(screenshotArtifact);

  const metadataPreview: PackageMetadata = {
    timestamp: input.packagedAt,
    url: input.url,
    producer: "extension",
    capabilities: SCREENSHOT_REPORT_CAPABILITIES,
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
    capabilities: SCREENSHOT_REPORT_CAPABILITIES,
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
