/**
 * Opt-in product feedback helpers: light diagnostics + message validation.
 *
 * Feedback is user-authored only (no background telemetry). Diagnostics stay
 * minimal so issue triage works without shipping tab URLs, tokens, or recordings.
 *
 * Issue title/body formatting lives in `feedback-format.ts` (pure, shared with Worker).
 */

export {
  buildFeedbackIssueTitle,
  FEEDBACK_MESSAGE_MAX_LENGTH,
  type FeedbackDiagnostics,
  formatFeedbackIssueBody,
  normalizeFeedbackDiagnostics,
  validateFeedbackMessage,
} from "./feedback-format";

import type { FeedbackDiagnostics } from "./feedback-format";

/** Coarse OS label from a user-agent string. */
export function parseOsFromUserAgent(userAgent: string): string {
  const ua = userAgent || "";
  if (/CrOS/i.test(ua)) {
    return "Chrome OS";
  }
  if (/Android/i.test(ua)) {
    return "Android";
  }
  if (/iPhone|iPad|iPod/i.test(ua)) {
    return "iOS";
  }
  if (/Mac OS X|Macintosh/i.test(ua)) {
    return "macOS";
  }
  if (/Windows/i.test(ua)) {
    return "Windows";
  }
  if (/Linux/i.test(ua)) {
    return "Linux";
  }
  return "Unknown";
}

export function parseBrowserFromUserAgent(userAgent: string): {
  browserName?: string;
  browserVersion?: string;
} {
  const matchers: Array<[string, RegExp]> = [
    ["Edge", /Edg\/([0-9.]+)/],
    ["Chrome", /Chrome\/([0-9.]+)/],
    ["Firefox", /Firefox\/([0-9.]+)/],
    ["Safari", /Version\/([0-9.]+).*Safari/],
  ];

  for (const [browserName, pattern] of matchers) {
    const match = userAgent.match(pattern);
    if (match?.[1]) {
      return { browserName, browserVersion: match[1] };
    }
  }

  return {};
}

/**
 * Build the light diagnostics payload for a feedback submission.
 * Safe to call from popup or service worker (extension pages).
 */
export function buildFeedbackDiagnostics(): FeedbackDiagnostics {
  const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const locale = typeof navigator !== "undefined" ? navigator.language || "" : "";
  let extensionVersion = "";
  try {
    extensionVersion =
      typeof chrome !== "undefined" && chrome.runtime?.getManifest
        ? chrome.runtime.getManifest().version || ""
        : "";
  } catch {
    extensionVersion = "";
  }

  return {
    extensionVersion,
    ...parseBrowserFromUserAgent(userAgent),
    os: parseOsFromUserAgent(userAgent),
    locale: locale || undefined,
  };
}
