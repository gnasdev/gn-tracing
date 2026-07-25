/**
 * Submits opt-in product feedback to the maintainer Worker proxy.
 *
 * The extension never holds a GitHub token; the Worker creates the issue.
 */

import {
  type FeedbackDiagnostics,
  normalizeFeedbackDiagnostics,
  validateFeedbackMessage,
} from "../shared/feedback";
import type { MessageResponse } from "../types/messages";

declare const __FEEDBACK_PROXY_URL__: string;

export interface SubmitFeedbackResult extends MessageResponse {
  issueUrl?: string;
  issueNumber?: number;
}

function getFeedbackProxyUrl(): string {
  try {
    return String(__FEEDBACK_PROXY_URL__ || "").trim();
  } catch {
    return "";
  }
}

/**
 * Validate and POST feedback to the Worker. Returns a MessageResponse-shaped
 * result for the popup toast / error UI.
 */
export async function submitFeedback(
  data: Record<string, unknown> | undefined,
): Promise<SubmitFeedbackResult> {
  const validated = validateFeedbackMessage(data?.message);
  if (!validated.ok) {
    return { ok: false, error: validated.error };
  }

  const diagnostics: FeedbackDiagnostics = normalizeFeedbackDiagnostics(data?.diagnostics);
  const proxyUrl = getFeedbackProxyUrl();
  if (!proxyUrl) {
    return {
      ok: false,
      error:
        "Feedback service is not configured. Open GitHub Issues from the repo link, or rebuild with the feedback proxy URL set.",
    };
  }

  let response: Response;
  try {
    response = await fetch(proxyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: validated.message,
        diagnostics,
      }),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `Could not reach the feedback service: ${detail}`,
    };
  }

  let body: {
    ok?: boolean;
    issueUrl?: string;
    issueNumber?: number;
    error?: string;
    error_description?: string;
  } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // Non-JSON body — fall through to status-based message.
  }

  if (!response.ok || body.ok === false) {
    const detail =
      body.error_description ||
      body.error ||
      (response.status === 429
        ? "Too many feedback submissions. Please try again later."
        : `Feedback service returned HTTP ${response.status}.`);
    return { ok: false, error: detail };
  }

  return {
    ok: true,
    issueUrl: typeof body.issueUrl === "string" ? body.issueUrl : undefined,
    issueNumber: typeof body.issueNumber === "number" ? body.issueNumber : undefined,
    message: "Feedback submitted.",
  };
}
