/**
 * Shared target-tab validation for recording entry points.
 */
export interface RecordingTabLike {
  id?: number;
  url?: string;
  pendingUrl?: string;
}

export interface RecordingTabTarget {
  url: string | null;
  error: string | null;
}

const RECORDABLE_TAB_PROTOCOLS = new Set(["http:", "https:", "file:"]);

export function getRecordingTabTarget(
  tab: RecordingTabLike | null | undefined,
): RecordingTabTarget {
  if (typeof tab?.id !== "number") {
    return { url: null, error: "Open a browser tab before starting a recording." };
  }

  const url = tab.url || tab.pendingUrl || "";
  if (!url) {
    return {
      url: null,
      error: "Cannot record this tab because the browser did not expose a page URL.",
    };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { url: null, error: "Cannot record this tab because its page URL is not supported." };
  }

  if (
    parsedUrl.hostname === "chromewebstore.google.com" ||
    (parsedUrl.hostname === "chrome.google.com" && parsedUrl.pathname.startsWith("/webstore"))
  ) {
    return {
      url: null,
      error: "Cannot record Chrome Web Store pages. Please open a regular webpage.",
    };
  }

  if (!RECORDABLE_TAB_PROTOCOLS.has(parsedUrl.protocol)) {
    // Browser and extension pages such as chrome://, edge://, devtools://,
    // chrome-extension://, about:, data:, and blob: do not reliably allow both
    // tabCapture and debugger attachment, so reject them before starting state.
    return {
      url: null,
      error:
        "Cannot record browser system, extension, or internal pages. Please open a regular webpage.",
    };
  }

  return { url, error: null };
}
