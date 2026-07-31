/**
 * One-shot DOM serializer injected for screenshot captures.
 *
 * Not always-on registration — the service worker injects this file when the
 * user clicks Screenshot, then messages it once. Guarded so re-inject does not
 * stack listeners.
 */

import { serializeDomTree } from "../../packages/replay-core/src/capture/dom-snapshot";
import type { DomSnapshot } from "../../packages/replay-core/src/schema/capture";
import { CAPTURE_PAGE_DOM_SNAPSHOT_ACTION } from "../shared/capture-page-dom";

interface PageDomSnapshotWindow extends Window {
  __gnTracingPageDomSnapshot?: boolean;
}

const pageWindow = window as PageDomSnapshotWindow;
if (!pageWindow.__gnTracingPageDomSnapshot) {
  pageWindow.__gnTracingPageDomSnapshot = true;

  chrome.runtime.onMessage.addListener(
    (message: { action?: string }, _sender, sendResponse: (response: unknown) => void): boolean => {
      if (message?.action !== CAPTURE_PAGE_DOM_SNAPSHOT_ACTION) {
        return false;
      }

      try {
        const serialized = serializeDomTree(document, {
          includeFormValues: false,
        });
        const snapshot: DomSnapshot = {
          label: "screenshot",
          capturedAt: Date.now(),
          documentUrl: typeof location?.href === "string" ? location.href : "",
          root: serialized.root,
        };
        sendResponse({
          ok: true,
          snapshot,
          truncated: serialized.truncated,
          nodeCount: serialized.nodeCount,
        });
      } catch (error) {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return false;
    },
  );
}
