/**
 * POST /feedback — create a GitHub issue from opt-in product feedback.
 */

import {
  buildFeedbackIssueTitle,
  formatFeedbackIssueBody,
  normalizeFeedbackDiagnostics,
  validateFeedbackMessage,
} from "../../../../src/shared/feedback-format";
import type { Env } from "../../env";
import { parseCommaList } from "../../env";
import { readJsonBody } from "../../http/body";
import { jsonResponse } from "../../http/response";
import { feedbackRateLimiter } from "../../middleware/rate-limit";
import { createGitHubIssue } from "./github";

/**
 * True when pathname is the feedback route (after optional version strip).
 * Pass the remainder from `stripRouteVersionPrefix`, not the raw URL path,
 * when the request may include `/{version}/feedback`.
 */
export function isFeedbackPath(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/";
  return path === "/feedback";
}

// Re-export formatters for worker unit tests (same functions as extension shared).
export { buildFeedbackIssueTitle, formatFeedbackIssueBody };

function parseFeedbackLabels(env: Env): string[] {
  const raw = (env.GITHUB_FEEDBACK_LABELS ?? "feedback").trim();
  if (!raw) {
    return [];
  }
  return parseCommaList(raw).slice(0, 5);
}

export async function handleFeedback(
  request: Request,
  env: Env,
  origin: string | null,
): Promise<Response> {
  const reply = (body: unknown, status: number) =>
    jsonResponse(body, status, origin, env, "feedback");

  const token = (env.GITHUB_FEEDBACK_TOKEN ?? "").trim();
  if (!token) {
    return reply(
      {
        error: "server_misconfigured",
        error_description:
          "Feedback is not configured on this Worker (missing GITHUB_FEEDBACK_TOKEN).",
      },
      503,
    );
  }

  const rate = await feedbackRateLimiter.consume(request);
  if (!rate.allowed) {
    return reply(
      {
        error: "rate_limited",
        error_description: "Too many feedback submissions. Please try again later.",
      },
      429,
    );
  }

  const parsed = await readJsonBody(request);
  if (!parsed.ok) {
    if (parsed.reason === "too_large") {
      return reply(
        { error: "invalid_request", error_description: "Request body is too large." },
        413,
      );
    }
    return reply(
      { error: "invalid_request", error_description: "Request body must be JSON." },
      400,
    );
  }

  const payload = parsed.value as Record<string, unknown>;
  const validated = validateFeedbackMessage(payload.message);
  if (!validated.ok) {
    return reply({ error: "invalid_request", error_description: validated.error }, 400);
  }

  const diagnostics = normalizeFeedbackDiagnostics(payload.diagnostics);
  const title = buildFeedbackIssueTitle(validated.message);
  const body = formatFeedbackIssueBody(validated.message, diagnostics);
  const owner = (env.GITHUB_REPO_OWNER ?? "gnasdev").trim() || "gnasdev";
  const repo = (env.GITHUB_REPO_NAME ?? "gn-tracing").trim() || "gn-tracing";
  const labels = parseFeedbackLabels(env);

  let result: Awaited<ReturnType<typeof createGitHubIssue>>;
  try {
    result = await createGitHubIssue({
      token,
      owner,
      repo,
      title,
      body,
      labels,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return reply({ error: "upstream_unreachable", error_description: detail }, 502);
  }

  if (!result.ok) {
    const status = result.status >= 400 && result.status < 600 ? result.status : 502;
    return reply(
      {
        error: "github_error",
        error_description: result.detail,
      },
      status === 401 || status === 403 ? 502 : status,
    );
  }

  return reply(
    {
      ok: true,
      issueUrl: result.htmlUrl,
      issueNumber: result.number,
    },
    201,
  );
}
