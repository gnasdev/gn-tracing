/**
 * Screenshots for the in-page SDK.
 *
 * The SDK cannot rasterise the viewport. No page API exposes the rendered
 * pixels, and `getDisplayMedia` — the usual escape hatch — is unavailable on
 * exactly the mobile browsers this SDK exists to serve. Rather than ship a
 * half-working canvas rasteriser that silently drops cross-origin images, web
 * fonts, and anything behind a shadow root, a "screenshot" here is a serialized
 * DOM snapshot the player re-renders.
 *
 * That is an honest trade and it is declared as one: the package advertises
 * `dom-snapshot` and `annotation`, never `screenshot`, and each entry records
 * `source.kind === "dom-snapshot"` so a reader is told it is looking at a
 * re-render rather than a photograph.
 *
 * Annotations are the same model the extension's editor produces, in the same
 * normalised coordinate space, so the player draws them with one renderer.
 */

import {
  type SerializedDomNode,
  serializeDomTree,
} from "../../replay-core/src/capture/dom-snapshot";
import type { Annotation, Screenshot } from "../../replay-core/src/schema/annotation";

export interface CaptureScreenshotOptions {
  /** Shown above the screenshot in the player and the bug report. */
  caption?: string;
  annotations?: Annotation[];
  /** CSS selectors whose subtrees are replaced with a masked placeholder. */
  maskSelectors?: string[];
  /** Include live form values. Off by default — those are the user's keystrokes. */
  includeFormValues?: boolean;
}

export interface CapturedScreenshot {
  screenshot: Screenshot;
  /** The serialized tree, appended to `dom.json` by the session. */
  domRoot: SerializedDomNode;
  /** True when the node cap cut the tree short. */
  truncated: boolean;
}

let screenshotCounter = 0;

function nextScreenshotId(now: number): string {
  screenshotCounter += 1;
  return `shot-${now.toString(36)}-${screenshotCounter.toString(36)}`;
}

/**
 * Serializes the current page as a screenshot entry.
 *
 * `snapshotIndex` is assigned by the caller, which owns the `dom.json` list;
 * this function does not know how many snapshots already exist.
 */
export function captureScreenshot(
  target: Window,
  snapshotIndex: number,
  options: CaptureScreenshotOptions = {},
): CapturedScreenshot {
  const capturedAt = Date.now();
  const serialized = serializeDomTree(target.document, {
    maskSelectors: options.maskSelectors,
    includeFormValues: options.includeFormValues,
  });

  return {
    screenshot: {
      id: nextScreenshotId(capturedAt),
      capturedAt,
      url: target.location?.href,
      title: target.document?.title,
      viewport: {
        width: target.innerWidth,
        height: target.innerHeight,
        devicePixelRatio: target.devicePixelRatio,
      },
      source: { kind: "dom-snapshot", snapshotIndex },
      annotations: options.annotations ?? [],
      caption: options.caption,
    },
    domRoot: serialized.root,
    truncated: serialized.truncated,
  };
}

/**
 * Converts a pointer position into the normalised space annotations use.
 *
 * Exported because a host application building its own annotation UI needs the
 * same conversion the player will invert; doing it by hand is how an arrow ends
 * up a few percent off on every device but the one it was drawn on.
 */
export function toNormalizedPoint(
  target: Window,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const width = target.innerWidth || 1;
  const height = target.innerHeight || 1;
  return {
    x: Math.min(1, Math.max(0, clientX / width)),
    y: Math.min(1, Math.max(0, clientY / height)),
  };
}
