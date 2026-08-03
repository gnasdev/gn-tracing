/**
 * Structural ZIP central-directory parse for player tests.
 *
 * Canonical implementation: `packages/replay-core/src/zip-reader.ts`.
 * Production `player.js` unzip also uses `gnCore.zip.parseZipCentralDirectory`
 * for the same layout — do not reimplement EOCD walking here.
 */

export {
  MAX_EOCD_SEARCH_SPAN,
  parseZipCentralDirectory,
  type ZipEntryRecord,
  type ZipParseError,
  type ZipParseErrorCode,
  type ZipParseResult,
  type ZipParseSuccess,
} from "../../packages/replay-core/src/zip-reader";
