/**
 * Recording artifact models — re-exported from the shared core.
 *
 * The definitions moved to `packages/replay-core/src/schema/capture.ts` so the
 * extension, the browser SDK, the player, and the MCP servers all describe the
 * recording format with one set of types. This file stays because ~14 modules
 * under `src/` import from it, and a churn-only rewrite of those imports would
 * bury the parts of this refactor that actually change behavior.
 *
 * New code under `src/` may import from either path; both resolve to the same
 * declarations.
 */

export * from "../../packages/replay-core/src/schema/capture";
