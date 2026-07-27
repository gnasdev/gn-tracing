/**
 * In-page (MAIN world) capture instrumentation — re-exported from the core.
 *
 * The implementation moved to
 * `packages/replay-core/src/capture/in-page-capture.ts`. It was always free of
 * `chrome.*` by design, which is exactly what made it the capture engine the
 * browser SDK needed: the extension injects it into a page's MAIN world, and
 * the SDK is simply a page that imports it directly.
 *
 * This file stays so `src/content/in-page-capture.ts` keeps its import path.
 */

export * from "../../packages/replay-core/src/capture/in-page-capture";
