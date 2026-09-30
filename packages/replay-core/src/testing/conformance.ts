/**
 * The recording-package conformance contract.
 *
 * One reusable set of assertions that every *producer* must satisfy and every
 * *reader* must be able to run. It exists because the repository now has two
 * producers (the extension packager and the browser SDK) feeding three readers
 * (the player, the local MCP server, the Worker route), and a format that only
 * one producer gets right is not a format.
 *
 * The assertions deliberately go through the shipped reader — `openRecording-
 * Package`, `createRecordingSession`, `buildAgentSummary` — rather than
 * re-deriving expectations from the writer. A package that passes here is one
 * the real consumers can open, not one that merely matches the writer's own
 * assumptions.
 *
 * Returns findings instead of calling `expect`, so it stays free of any test
 * framework and can run from any context's suite.
 */

import { openRecordingPackageFromBytes } from "../artifacts";
import { createRecordingSession } from "../query";
import {
  ARTIFACT_FILENAMES,
  type ArtifactId,
  type RecordingCapability,
  type RecordingProducer,
  resolveCapabilities,
} from "../schema";
import type { InstantReplayArtifact, ScreenshotArtifact } from "../schema/annotation";
import { screenshotHasUnbakedRedactions } from "../schema/annotation";

export interface ConformanceExpectations {
  producer: RecordingProducer;
  /** Capabilities the producer must declare. */
  capabilities: RecordingCapability[];
  /** Artifacts the package must carry. */
  requiredArtifacts: ArtifactId[];
  /** True when the package is expected to carry video parts. */
  expectVideo: boolean;
  /** True when the package must carry an annotated screenshot set. */
  expectScreenshots?: boolean;
  /** Password, for a protected package. */
  password?: string;
}

export interface ConformanceReport {
  /** Human-readable failures. Empty means the package conforms. */
  violations: string[];
  /** Artifact ids the reader could resolve. */
  availableArtifacts: ArtifactId[];
  entryNames: string[];
}

/** Index documents a ranged reader must find without touching the video. */
const EARLY_ENTRIES = [
  ARTIFACT_FILENAMES.index,
  ARTIFACT_FILENAMES.manifest,
  ARTIFACT_FILENAMES.metadata,
];

export async function checkPackageConformance(
  bytes: Uint8Array,
  expectations: ConformanceExpectations,
): Promise<ConformanceReport> {
  const violations: string[] = [];
  const pkg = await openRecordingPackageFromBytes(bytes, { password: expectations.password });
  const entryNames = pkg.entries.map((entry) => entry.name);

  // --- Producer identity -----------------------------------------------
  if (pkg.metadata.producer !== expectations.producer) {
    violations.push(
      `metadata.producer is ${String(pkg.metadata.producer)}, expected ${expectations.producer}`,
    );
  }
  const declared = resolveCapabilities(pkg.metadata);
  for (const capability of expectations.capabilities) {
    if (!declared.includes(capability)) {
      violations.push(`capability "${capability}" is missing from metadata.capabilities`);
    }
  }

  // A producer must not claim video it did not write, or write video it did
  // not claim: readers branch on the capability, not on the entry list.
  const videoEntries = entryNames.filter((name) => name.startsWith("video.part-"));
  const claimsVideo = declared.includes("video");
  if (expectations.expectVideo !== videoEntries.length > 0) {
    violations.push(
      `expected ${expectations.expectVideo ? "video parts" : "no video parts"}, found ${videoEntries.length}`,
    );
  }
  if (videoEntries.length > 0 && !claimsVideo) {
    violations.push("package carries video parts but does not declare the video capability");
  }

  // --- Index documents --------------------------------------------------
  for (const name of EARLY_ENTRIES) {
    if (!entryNames.includes(name)) {
      violations.push(`missing required index document ${name}`);
    }
  }
  const firstVideoIndex = entryNames.findIndex((name) => name.startsWith("video.part-"));
  if (firstVideoIndex >= 0) {
    for (const name of [...EARLY_ENTRIES, ARTIFACT_FILENAMES.agentSummary]) {
      const position = entryNames.indexOf(name);
      if (position >= 0 && position > firstVideoIndex) {
        violations.push(
          `${name} is written after the video parts; a ranged reader cannot reach it`,
        );
      }
    }
  }

  // --- Artifacts resolve and parse --------------------------------------
  for (const id of expectations.requiredArtifacts) {
    if (!pkg.hasArtifact(id)) {
      violations.push(`required artifact "${id}" is not resolvable`);
      continue;
    }
    try {
      const parsed = await pkg.readArtifact(id);
      if (parsed === null) {
        violations.push(`artifact "${id}" resolved but read back as null`);
      }
    } catch (cause) {
      violations.push(`artifact "${id}" failed to parse: ${describe(cause)}`);
    }
  }

  // Every path the manifest advertises must actually exist. A dangling entry
  // is how a reader ends up throwing on a package that looks complete.
  for (const [id, path] of Object.entries(pkg.manifest?.artifacts ?? {})) {
    if (path && !entryNames.includes(path)) {
      violations.push(`manifest points "${id}" at ${path}, which is not in the package`);
    }
  }
  for (const [key, path] of Object.entries(pkg.index?.artifacts ?? {})) {
    if (path && !entryNames.includes(path)) {
      violations.push(`recording-index points "${key}" at ${path}, which is not in the package`);
    }
  }

  // --- Screenshots -------------------------------------------------------
  const screenshotArtifact = await pkg
    .readArtifact<ScreenshotArtifact>("screenshots")
    .catch(() => null);

  if (expectations.expectScreenshots && !screenshotArtifact) {
    violations.push("expected a screenshots artifact, found none");
  }

  for (const screenshot of screenshotArtifact?.screenshots ?? []) {
    // The invariant that actually protects someone: a redaction the producer
    // never applied means the region is still readable in the stored image.
    if (screenshotHasUnbakedRedactions(screenshot)) {
      violations.push(
        `screenshot ${screenshot.id} ships a pending redaction; its hidden region is still readable`,
      );
    }

    if (screenshot.source.kind === "image") {
      if (!entryNames.includes(screenshot.source.path)) {
        violations.push(
          `screenshot ${screenshot.id} points at ${screenshot.source.path}, which is not in the package`,
        );
      }
      if (!declared.includes("screenshot")) {
        violations.push(
          `screenshot ${screenshot.id} carries a raster image but the package does not declare the screenshot capability`,
        );
      }
    } else if (!declared.includes("dom-snapshot")) {
      violations.push(
        `screenshot ${screenshot.id} is a DOM snapshot but the package does not declare the dom-snapshot capability`,
      );
    }

    if (screenshot.annotations.length > 0 && !declared.includes("annotation")) {
      violations.push(
        `screenshot ${screenshot.id} carries annotations but the package does not declare the annotation capability`,
      );
    }

    if (screenshot.viewport.width <= 0 || screenshot.viewport.height <= 0) {
      violations.push(
        `screenshot ${screenshot.id} has a zero-sized viewport, so its normalised annotations cannot be placed`,
      );
    }
  }

  // --- Instant replay ----------------------------------------------------
  const instantReplay = await pkg
    .readArtifact<InstantReplayArtifact>("instantReplay")
    .catch(() => null);

  if (instantReplay) {
    if (!declared.includes("instant-replay")) {
      violations.push(
        "package carries an instant-replay artifact but does not declare the instant-replay capability",
      );
    }
    if (instantReplay.coveredMs > instantReplay.windowMs) {
      violations.push(
        "instant replay claims to cover more time than its configured window, which no buffer can do",
      );
    }
    if (instantReplay.frames.length > 0 && instantReplay.frames[0].relativeMs !== 0) {
      violations.push("instant replay frames are not numbered from the first retained frame");
    }
  }

  // --- The reader's own query surface -----------------------------------
  try {
    const session = createRecordingSession(pkg);
    const summary = await session.summary();
    if (typeof summary.schemaVersion !== "number") {
      violations.push("agent summary has no schemaVersion");
    }
    await session.consoleViews();
    await session.networkViews();
    await session.websocketViews();
    await session.eventViews();
  } catch (cause) {
    violations.push(`the reader's query surface failed on this package: ${describe(cause)}`);
  }

  return { violations, availableArtifacts: pkg.availableArtifacts, entryNames };
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
