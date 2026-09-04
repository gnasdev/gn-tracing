/**
 * `@gn-tracing/replay-core` — reading a GN Tracing recording package outside a
 * browser page.
 *
 * Consumers: the local MCP server (`mcp/`), the remote MCP route
 * (`worker/src/index.ts`), and the extension packager, which imports
 * `buildAgentSummary` so the artifact it writes and the one computed on the fly
 * can never disagree.
 *
 * Constraints that make that possible: no DOM, no `chrome.*`, no secrets, and no
 * API beyond what browsers, Node 18+, and workerd all provide.
 */

export {
  DEFAULT_MAX_ENTRY_BYTES,
  type OpenPackageOptions,
  openRecordingPackage,
  openRecordingPackageFromBytes,
  type RecordingPackage,
} from "./artifacts";
export {
  type HydrateDomOptions,
  hydrateDomNodeToHtml,
} from "./dom/hydrate-dom";
export {
  isReplayError,
  ReplayError,
  type ReplayErrorCode,
  toReplayError,
} from "./errors";
export {
  type ByteRangeSource,
  createBytesSource,
  createHttpSource,
  DEFAULT_MAX_PACKAGE_BYTES,
  type FetchLike,
  type HttpSourceOptions,
  parseContentRange,
  type TailRead,
} from "./package-source";
export {
  parseProductVersion,
  pickProductVersion,
  productVersionOrDefault,
  requireProductVersion,
} from "./product-version";
export {
  type ConsoleEntryDetail,
  type ConsoleFilters,
  type CookieSummary,
  createRecordingSession,
  DEFAULT_PAGE_LIMIT,
  type DomSnapshotIndex,
  type DomSnapshotOptions,
  type DomSnapshotSummary,
  getConsoleEntry,
  getNetworkRequest,
  listConsole,
  listNetwork,
  listUserEvents,
  listWebSocketFrames,
  listWebSockets,
  MAX_BODY_CHARS,
  MAX_DIAGNOSTIC_GROUPS,
  MAX_DOM_HTML_CHARS,
  MAX_FRAME_PAYLOAD_CHARS,
  MAX_FRAMES,
  MAX_MESSAGE_CHARS,
  MAX_PAGE_LIMIT,
  MAX_STORAGE_KEYS,
  type NetworkDetailOptions,
  type NetworkFilters,
  type NetworkRequestDetail,
  type Page,
  type PageRequest,
  paginate,
  type RecordingSession,
  type ReporterReport,
  readDomSnapshots,
  readReporterReport,
  readSourceMapDiagnostics,
  readStorage,
  type SearchFilters,
  type SearchHit,
  type SearchPage,
  type SearchScope,
  type SourceMapDiagnosticsSummary,
  type SourceMapFailureGroup,
  type StorageEntrySummary,
  type StorageReport,
  type StorageSnapshotSummary,
  searchRecording,
  type TextPayload,
  type TimelineFilters,
  type WebSocketFrameView,
} from "./query";
export {
  buildPackageDownloadUrl,
  buildReplayUrl,
  DEFAULT_PLAYER_ORIGIN,
  isStorageProviderId,
  isSupportedRecordingRef,
  normalizeStorageProviderId,
  parseStorageRecordingRef,
  STORAGE_PROVIDER_IDS,
  STORAGE_PROVIDER_PATH_SEGMENTS,
  type StorageProviderId,
  type StorageRecordingRef,
} from "./recording-ref";
export { type BugReportOptions, renderBugReportMarkdown } from "./report";
export {
  isProductRouteVersion,
  joinVersionedPath,
  pickWorkerOrigin,
  resolveVersionedWorkerEndpoints,
  type StrippedRouteVersion,
  stripRouteVersionPrefix,
  type WorkerEndpoints,
} from "./route-version";
// The format itself. Re-exported from the root so existing readers keep their
// single import; producers should prefer `./schema` directly.
export * from "./schema";
export {
  AGENT_SUMMARY_SCHEMA_VERSION,
  type AgentSummary,
  type AgentSummaryError,
  type AgentSummaryRequest,
  type AgentSummaryTimelineEntry,
  buildAgentSummary,
  SUMMARY_LIMITS,
  type SummaryInput,
} from "./summarize";
export { coerceEpochMs } from "./time";
export {
  buildConsoleViews,
  buildEventViews,
  buildNetworkViews,
  buildWebSocketViews,
  type ConsoleView,
  type EventView,
  isErrorConsoleView,
  isWarningConsoleView,
  type NetworkView,
  resolveRecordingStartTime,
  type SourceLocationView,
  unwrapArtifactList,
  type WebSocketView,
} from "./views";
export {
  calculateCrc32,
  decodeZipEntryPayload,
  decryptZipCryptoPayload,
  inflateRawBytes,
  locateZipCentralDirectory,
  MAX_EOCD_SEARCH_SPAN,
  parseZipCentralDirectory,
  parseZipDirectoryEntries,
  resolveZipPayloadSpan,
  ZipEntryError,
  type ZipEntryRecord,
  type ZipParseError,
  type ZipParseErrorCode,
  type ZipParseResult,
} from "./zip-reader";
