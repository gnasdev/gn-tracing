/**
 * Pure feedback issue title/body formatting (no browser/Worker APIs).
 *
 * Used by the extension (`feedback.ts`) and the Cloudflare Worker so GitHub
 * issue shape cannot drift between client validation and server issue creation.
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
  const browser =
    [diagnostics.browserName, diagnostics.browserVersion].filter(Boolean).join(" ") || "unknown";
  return [
    "## Feedback",
    "",
    "```",
    safeMessage,
    "```",
    "",
    "## Diagnostics",
    "",
    `- Extension: ${diagnostics.extensionVersion || "unknown"}`,
    `- Browser: ${browser}`,
    `- OS: ${diagnostics.os || "unknown"}`,
    `- Locale: ${diagnostics.locale || "unknown"}`,
    "",
    "---",
    "Submitted from the GN Tracing browser extension.",
  ].join("\n");
}
