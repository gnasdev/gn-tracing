/**
 * `@gn-tracing/replay-core/write` — producing a recording package.
 *
 * The mirror of the reader in `../artifacts.ts`. Every producer goes through
 * `buildRecordingPackage`, which is what keeps a package written by the SDK
 * readable by the same player and MCP tools as one written by the extension.
 */

export {
  type AgentSummaryArtifactInput,
  buildAgentSummaryArtifact,
  MAX_AGENT_SUMMARY_INPUT_BYTES,
} from "./agent-summary";
export {
  type AttachableArtifactId,
  type BuildPackageInput,
  type BuiltPackage,
  buildRecordingPackage,
  encodeJsonArtifact,
  splitIntoParts,
  type VideoInput,
  type VideoPartInput,
  videoPartName,
} from "./package-writer";
export {
  type BuildZipOptions,
  buildZipArchive,
  concatChunks,
  createZipEncryptedPayload,
  deflateRawBytes,
  shouldCompressZipEntry,
  type ZipInputEntry,
} from "./zip-writer";
