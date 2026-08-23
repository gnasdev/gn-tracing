/**
 * `agent-summary.json` — the bounded, ranked view of a recording.
 *
 * One implementation, three callers: the extension writes it into the package at
 * upload time (`src/offscreen/offscreen.ts`), and both MCP transports compute it
 * on the fly for packages recorded before the artifact existed. That is the
 * whole point of putting it here — a second copy would drift silently.
 *
 * Design rules:
 * - **Deterministic.** Stable ordering (by `atMs`, then index) so two runs over
 *   the same package produce byte-identical output and golden tests are honest.
 * - **Bounded.** Every list has a cap and every cap is reported in `truncation`,
 *   so "5 errors" never silently means "5 of 300".
 * - **Privacy-preserving.** It only re-reads data that already passed redaction;
 *   it never adds a field the artifacts did not already contain.
 */

import type { PackageMetadata } from "./schema/package";
import {
  buildConsoleViews,
  buildEventViews,
  buildNetworkViews,
  buildWebSocketViews,
  type ConsoleView,
  isErrorConsoleView,
  isWarningConsoleView,
  type NetworkView,
  resolveRecordingStartTime,
} from "./views";

export const AGENT_SUMMARY_SCHEMA_VERSION = 1;

/** List caps. Raising one changes the artifact's size budget — do it knowingly. */
export const SUMMARY_LIMITS = {
  topErrors: 10,
  failedRequests: 15,
  slowRequests: 5,
  websocket: 5,
  timeline: 40,
  messageChars: 500,
  urlChars: 300,
} as const;

/** Requests slower than this are worth surfacing on their own. */
const SLOW_REQUEST_MS = 2000;

export interface AgentSummaryError {
  id: string;
  atMs: number | null;
  level: string;
  message: string;
  origin: {
    file: string;
    line?: number;
    column?: number;
    mapped: boolean;
    unmappedReason?: string;
  } | null;
  /** How many times the same message+location appeared. */
  occurrences: number;
  hasStack: boolean;
}

export interface AgentSummaryRequest {
  id: string;
  atMs: number | null;
  method: string;
  url: string;
  status: number | null;
  statusText: string | null;
  durationMs: number | null;
  resourceType: string;
  error: string | null;
}

export interface AgentSummaryTimelineEntry {
  atMs: number | null;
  kind: string;
  label: string;
  selector?: string;
}

export interface AgentSummary {
  schemaVersion: number;
  generatedAt: string;
  session: {
    pageUrl: string;
    pageTitle: string | null;
    startedAt: string | null;
    durationMs: number | null;
  };
  environment: {
    browser: string | null;
    extensionVersion: string | null;
    viewport: string | null;
    language: string | null;
    timezone: string | null;
  };
  capture: {
    storageProvider: string | null;
    artifacts: string[];
    evidenceCoverage?: PackageMetadata["evidenceCoverage"];
  };
  counts: {
    console: number;
    errors: number;
    warnings: number;
    network: number;
    networkFailed: number;
    networkIncomplete: number;
    websocket: number;
    events: number;
  };
  topErrors: AgentSummaryError[];
  failedRequests: AgentSummaryRequest[];
  slowRequests: AgentSummaryRequest[];
  websocket: Array<{
    id: string;
    url: string;
    closed: boolean;
    frameCount: number;
    sentCount: number;
    receivedCount: number;
  }>;
  timeline: AgentSummaryTimelineEntry[];
  privacy: {
    profile: string | null;
    responseBodies: boolean | null;
    requestBodies: boolean | null;
    limitations: string[];
  };
  /** `"shown of total"` per capped list, so a reader can tell what was cut. */
  truncation: Record<string, string>;
}

/** Raw artifacts, exactly as parsed from the package (or held in memory). */
export interface SummaryInput {
  metadata: PackageMetadata;
  console?: unknown;
  network?: unknown;
  websocket?: unknown;
  events?: unknown;
  privacy?: unknown;
  report?: unknown;
  /** Artifact ids present in the package, for the `capture.artifacts` list. */
  availableArtifacts?: string[];
  /** Injected so callers control determinism (the extension passes upload time). */
  generatedAt?: string;
}

export function buildAgentSummary(input: SummaryInput): AgentSummary {
  const metadata = input.metadata ?? {};
  const startTime = resolveRecordingStartTime(metadata);

  const consoleViews = buildConsoleViews(input.console, startTime);
  const networkViews = buildNetworkViews(input.network, startTime);
  const websocketViews = buildWebSocketViews(input.websocket);
  const eventViews = buildEventViews(input.events, startTime);

  const errors = consoleViews.filter(isErrorConsoleView);
  const warnings = consoleViews.filter(isWarningConsoleView);
  const failed = networkViews.filter((view) => view.failed);
  const incomplete = networkViews.filter((view) => view.incomplete);
  const slow = networkViews
    .filter((view) => !view.failed && (view.durationMs ?? 0) >= SLOW_REQUEST_MS)
    .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0));

  const groupedErrors = groupConsoleErrors(errors);
  const report = asRecord(input.report);
  const privacy = asRecord(input.privacy);
  const artifactFlags = asRecord(privacy?.artifactFlags);
  const environment = asRecord(report?.environment);

  const timeline = eventViews.slice(0, SUMMARY_LIMITS.timeline).map((view) => ({
    atMs: view.atMs,
    kind: view.kind,
    label: truncate(view.label, 160),
    ...(view.selector ? { selector: truncate(view.selector, 160) } : {}),
  }));

  return {
    schemaVersion: AGENT_SUMMARY_SCHEMA_VERSION,
    generatedAt: input.generatedAt ?? new Date(0).toISOString(),
    session: {
      pageUrl: truncate(String(metadata.url ?? ""), SUMMARY_LIMITS.urlChars),
      pageTitle: asString(asRecord(report?.page)?.title) || null,
      startedAt: startTime > 0 ? new Date(startTime).toISOString() : null,
      durationMs: asFiniteNumber(metadata.duration),
    },
    environment: {
      browser: buildBrowserLabel(environment),
      extensionVersion: asString(environment?.extensionVersion) || null,
      viewport: buildViewportLabel(asRecord(environment?.viewport)),
      language: asString(environment?.language) || null,
      timezone: asString(environment?.timezone) || null,
    },
    capture: {
      storageProvider: asString(metadata.storage?.provider) || null,
      artifacts: [...(input.availableArtifacts ?? [])].sort(),
      ...(metadata.evidenceCoverage ? { evidenceCoverage: metadata.evidenceCoverage } : {}),
    },
    counts: {
      console: consoleViews.length,
      errors: errors.length,
      warnings: warnings.length,
      network: networkViews.length,
      networkFailed: failed.length,
      networkIncomplete: incomplete.length,
      websocket: websocketViews.length,
      events: eventViews.length,
    },
    topErrors: groupedErrors.slice(0, SUMMARY_LIMITS.topErrors),
    failedRequests: failed.slice(0, SUMMARY_LIMITS.failedRequests).map(toSummaryRequest),
    slowRequests: slow.slice(0, SUMMARY_LIMITS.slowRequests).map(toSummaryRequest),
    websocket: websocketViews.slice(0, SUMMARY_LIMITS.websocket).map((view) => ({
      id: view.id,
      url: truncate(view.url, SUMMARY_LIMITS.urlChars),
      closed: view.closed,
      frameCount: view.frameCount,
      sentCount: view.sentCount,
      receivedCount: view.receivedCount,
    })),
    timeline,
    privacy: {
      profile: asString(privacy?.profile) || null,
      responseBodies: asBoolean(artifactFlags?.responseBodies),
      requestBodies: asBoolean(artifactFlags?.requestBodies),
      limitations: Array.isArray(privacy?.limitations)
        ? privacy.limitations.filter((item): item is string => typeof item === "string")
        : [],
    },
    truncation: {
      topErrors: `${Math.min(groupedErrors.length, SUMMARY_LIMITS.topErrors)} of ${groupedErrors.length}`,
      failedRequests: `${Math.min(failed.length, SUMMARY_LIMITS.failedRequests)} of ${failed.length}`,
      slowRequests: `${Math.min(slow.length, SUMMARY_LIMITS.slowRequests)} of ${slow.length}`,
      websocket: `${Math.min(websocketViews.length, SUMMARY_LIMITS.websocket)} of ${websocketViews.length}`,
      timeline: `${timeline.length} of ${eventViews.length}`,
    },
  };
}

/**
 * Collapses repeats of the same error so ten identical render failures do not
 * crowd out the one distinct error that explains them.
 */
function groupConsoleErrors(errors: ConsoleView[]): AgentSummaryError[] {
  const grouped = new Map<string, AgentSummaryError>();
  for (const view of errors) {
    const existing = grouped.get(view.signature);
    if (existing) {
      existing.occurrences += 1;
      continue;
    }
    grouped.set(view.signature, {
      id: view.id,
      atMs: view.atMs,
      level: view.level,
      message: truncate(view.message, SUMMARY_LIMITS.messageChars),
      origin: view.location
        ? {
            file: truncate(view.location.file, SUMMARY_LIMITS.urlChars),
            ...(view.location.line !== undefined ? { line: view.location.line } : {}),
            ...(view.location.column !== undefined ? { column: view.location.column } : {}),
            mapped: view.location.mapped,
            ...(view.location.unmappedReason
              ? { unmappedReason: view.location.unmappedReason }
              : {}),
          }
        : null,
      occurrences: 1,
      hasStack: view.hasStack,
    });
  }
  return [...grouped.values()];
}

function toSummaryRequest(view: NetworkView): AgentSummaryRequest {
  return {
    id: view.id,
    atMs: view.atMs,
    method: view.method,
    url: truncate(view.url, SUMMARY_LIMITS.urlChars),
    status: view.status,
    statusText: view.statusText,
    durationMs: view.durationMs,
    resourceType: view.resourceType,
    error: view.error,
  };
}

function buildBrowserLabel(environment: Record<string, unknown> | null): string | null {
  if (!environment) {
    return null;
  }
  const name = asString(environment.browserName);
  const version = asString(environment.browserVersion);
  if (name && version) {
    return `${name} ${version}`;
  }
  return name || null;
}

function buildViewportLabel(viewport: Record<string, unknown> | null): string | null {
  if (!viewport) {
    return null;
  }
  const width = asFiniteNumber(viewport.width);
  const height = asFiniteNumber(viewport.height);
  return width && height ? `${width}x${height}` : null;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}…`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}
