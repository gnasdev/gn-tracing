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
  type ConsoleEntryDetail,
  type ConsoleFilters,
  createRecordingSession,
  DEFAULT_PAGE_LIMIT,
  getConsoleEntry,
  getNetworkRequest,
  listConsole,
  listNetwork,
  listUserEvents,
  listWebSockets,
  MAX_BODY_CHARS,
  MAX_PAGE_LIMIT,
  type NetworkDetailOptions,
  type NetworkFilters,
  type NetworkRequestDetail,
  type Page,
  type PageRequest,
  paginate,
  type RecordingSession,
  type SearchFilters,
  type SearchHit,
  type SearchScope,
  searchRecording,
  type TimelineFilters,
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
