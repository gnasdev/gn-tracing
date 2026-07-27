/**
 * `@gn-tracing/replay-core/annotate` — screenshot annotations.
 *
 * Split three ways by what each part is allowed to depend on:
 *
 * - `svg` and `describe` are pure. They run in the editor, the player, the MCP
 *   servers, and the Worker alike.
 * - `raster` needs `OffscreenCanvas` and is producer-side only. It is exported
 *   from here but reached through a separate entry so a reader never pulls a
 *   canvas dependency it cannot satisfy.
 */

export {
  describeAnnotation,
  describePoint,
  describeScreenshot,
  renderScreenshotMarkdown,
  type ScreenshotDescription,
} from "./describe";
export {
  DEFAULT_ANNOTATION_COLOR,
  DEFAULT_FONT_SIZE,
  DEFAULT_STROKE_WIDTH,
  escapeXml,
  type RenderOptions,
  renderAnnotationsSvg,
  renderScreenshotOverlaySvg,
} from "./svg";
