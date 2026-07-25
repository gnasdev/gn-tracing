/**
 * Opt-in product feedback helpers: light diagnostics + message validation.
 *
 * Feedback is user-authored only (no background telemetry). Diagnostics stay
 * minimal so issue triage works without shipping tab URLs, tokens, or recordings.
 */

export const FEEDBACK_MESSAGE_MAX_LENGTH = 4000;
export const FEEDBACK_TITLE_PREFIX = "Feedback: ";
export const FEEDBACK_TITLE_BODY_MAX = 60;

export interface FeedbackDiagnostics {
  extensionVersion: string;
  browserName?: string;
  browserVersion?: string;
  os?: string;
  locale?: string;
}

export type FeedbackValidationResult = { ok: true; message: string } | { ok: false; error: string };

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

/** Normalize and validate user message before network submit. */
export function validateFeedbackMessage(raw: unknown): FeedbackValidationResult {
  if (typeof raw !== "string") {
    return { ok: false, error: "Feedback message is required." };
  }
  const message = raw.trim();
  if (!message) {
    return { ok: false, error: "Feedback message is required." };
  }
  if (message.length > FEEDBACK_MESSAGE_MAX_LENGTH) {
    return {
      ok: false,
      error: `Feedback message must be at most ${FEEDBACK_MESSAGE_MAX_LENGTH} characters.`,
    };
  }
  return { ok: true, message };
}

/** Allow-list diagnostics fields from untrusted client payloads. */
export function normalizeFeedbackDiagnostics(value: unknown): FeedbackDiagnostics {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const pick = (key: string, max = 120): string | undefined => {
    const v = raw[key];
    if (typeof v !== "string") {
      return undefined;
    }
    const trimmed = v.replace(/\s+/g, " ").trim();
    if (!trimmed) {
      return undefined;
    }
    return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
  };

  return {
    extensionVersion: pick("extensionVersion", 32) || "unknown",
    browserName: pick("browserName", 40),
    browserVersion: pick("browserVersion", 40),
    os: pick("os", 40),
    locale: pick("locale", 40),
  };
}

export function buildFeedbackIssueTitle(message: string): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  const snippet =
    oneLine.length > FEEDBACK_TITLE_BODY_MAX
      ? `${oneLine.slice(0, FEEDBACK_TITLE_BODY_MAX)}…`
      : oneLine;
  return `${FEEDBACK_TITLE_PREFIX}${snippet || "from extension"}`;
}

/**
 * Format GitHub issue body. Message is wrapped in a fenced code block so
 * markdown injection from the user body stays contained as plain text.
 */
export function formatFeedbackIssueBody(message: string, diagnostics: FeedbackDiagnostics): string {
  const safeMessage = message.replace(/```/g, "'''");
  const lines = [
    "## Feedback",
    "",
    "```",
    safeMessage,
    "```",
    "",
    "## Diagnostics",
    "",
    `- Extension: ${diagnostics.extensionVersion || "unknown"}`,
    `- Browser: ${[diagnostics.browserName, diagnostics.browserVersion].filter(Boolean).join(" ") || "unknown"}`,
    `- OS: ${diagnostics.os || "unknown"}`,
    `- Locale: ${diagnostics.locale || "unknown"}`,
    "",
    "---",
    "Submitted from the GN Tracing browser extension.",
  ];
  return lines.join("\n");
}
