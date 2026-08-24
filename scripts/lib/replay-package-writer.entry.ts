/**
 * Thin re-export barrel so `build-replay-fixture.mjs` can bundle the real
 * package writer (whose internal imports are extensionless, i.e. bundler-only)
 * into plain ESM it can `import()` at runtime. See that file's header comment.
 */
export { EXTENSION_CAPABILITIES } from "../../packages/replay-core/src/schema/package";
export {
  buildRecordingPackage,
  encodeJsonArtifact,
} from "../../packages/replay-core/src/write/package-writer";
export { concatChunks } from "../../packages/replay-core/src/write/zip-writer";
