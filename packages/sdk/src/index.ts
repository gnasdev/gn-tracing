/**
 * `@gn-tracing/sdk` — record a GN Tracing session from inside a web page.
 *
 * Why this exists: the extension is the better recorder wherever it can run —
 * it has tab video, cross-origin network detail, and source-mapped stacks
 * through the debugger protocol. But no mobile browser can run it. Chrome for
 * Android has never supported extensions, iOS has no engine that exposes
 * `tabCapture`/`debugger`, and `getDisplayMedia` is unavailable on both. A page
 * that instruments itself is the only recorder those users can have.
 *
 * The package it writes is the same format the extension writes, so the hosted
 * player, the MCP server, and the `gn-tracing-replay` skill all read it with no
 * changes. What is missing is declared in `metadata.capabilities` rather than
 * left for a reader to infer from an absent artifact.
 *
 * ```ts
 * import { startRecording } from "@gn-tracing/sdk";
 *
 * const session = startRecording({ privacyProfile: "strict" });
 * // ... reproduce the bug ...
 * const { blob, filename } = await session.stop();
 * // Upload `blob` wherever your app already uploads user attachments.
 * ```
 *
 * Uploading is deliberately not included: an SDK embedded in someone's product
 * should not carry opinions about that product's storage or credentials.
 */

export {
  DEFAULT_ANNOTATION_COLOR,
  renderAnnotationsSvg,
  renderScreenshotOverlaySvg,
} from "../../replay-core/src/annotate";
// The annotation model and its renderer come from the core, so a host building
// its own editor draws the shapes the player will draw.
export type {
  Annotation,
  AnnotationType,
  NormalizedPoint,
  NormalizedRect,
  Screenshot,
} from "../../replay-core/src/schema/annotation";
export {
  type CapturedScreenshot,
  type CaptureScreenshotOptions,
  captureScreenshot,
  toNormalizedPoint,
} from "./screenshot";
export {
  DEFAULT_SESSION_LIMITS,
  RecordingSession,
  type SessionLimits,
  type SessionOptions,
  type StopResult,
} from "./session";
export {
  describeElement,
  installUserEventCapture,
  type UserEventCaptureOptions,
  type UserEventSink,
} from "./user-events";

import { RecordingSession, type SessionOptions } from "./session";

/** Constructs a session and starts capturing immediately. */
export function startRecording(options: SessionOptions = {}): RecordingSession {
  const session = new RecordingSession(options);
  session.start();
  return session;
}
