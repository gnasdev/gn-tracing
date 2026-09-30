/**
 * Deterministic auto-investigation.
 *
 * Given the same ranked evidence an agent would read, produce a structured
 * markdown verdict: a root-cause hypothesis with cited evidence, the files a
 * developer should open first, and what to try next. No LLM — the point is a
 * baseline that never leaks data and always answers in the same shape, which
 * the GitHub App webhook posts as an issue comment.
 */

import type { ReproStep } from "./repro-steps";
import type { AgentSummary } from "./summarize";

export interface InvestigationResult {
  /** One-line verdict for the comment header. */
  verdict: string;
  /** Confidence band: high when errors map to source, medium otherwise. */
  confidence: "high" | "medium" | "low";
  markdown: string;
}

function formatMs(ms: number | null): string {
  if (ms === null) {
    return "--:--";
  }
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function stepLabel(step: ReproStep): string {
  return step.detail ? `${step.label} (${step.detail})` : step.label;
}

export function investigateRecording(summary: AgentSummary): InvestigationResult {
  const errors = summary.topErrors;
  const failed = summary.failedRequests;
  const lines: string[] = [];

  const firstError = errors[0];
  const firstFailed = failed[0];
  const mappedOrigins = [
    ...new Set(
      errors
        .map((error) => error.origin)
        .filter((origin): origin is NonNullable<typeof origin> => Boolean(origin?.mapped))
        .map((origin) => `${origin.file}${origin.line !== undefined ? `:${origin.line}` : ""}`),
    ),
  ];

  let verdict = "Insufficient evidence to isolate a root cause.";
  let confidence: InvestigationResult["confidence"] = "low";

  if (firstError && mappedOrigins.length > 0) {
    verdict = `A runtime error likely caused the failure: ${firstError.message}`;
    confidence = "high";
  } else if (firstError) {
    verdict = `A runtime error likely caused the failure: ${firstError.message}`;
    confidence = "medium";
  } else if (firstFailed) {
    verdict = `A failed request likely caused the failure: ${firstFailed.method} ${firstFailed.url}`;
    confidence = "medium";
  } else if (summary.reproSteps.length === 0 && summary.counts.events === 0) {
    verdict = "The package captured almost no user activity — the recording may be incomplete.";
  }

  lines.push("## GN Tracing investigation");
  lines.push("");
  lines.push(`**Verdict:** ${verdict}`);
  lines.push(`**Confidence:** ${confidence}`);
  lines.push("");
  lines.push(
    `${summary.counts.errors} errors · ${summary.counts.warnings} warnings · ` +
      `${summary.counts.networkFailed} failed of ${summary.counts.network} requests · ` +
      `${summary.counts.events} user events`,
  );
  lines.push("");

  if (errors.length > 0) {
    lines.push("### Evidence — errors");
    lines.push("");
    for (const error of errors.slice(0, 5)) {
      const origin = error.origin
        ? ` — \`${error.origin.file}${error.origin.line !== undefined ? `:${error.origin.line}` : ""}\`${error.origin.mapped ? "" : " (generated; no source map)"}`
        : "";
      lines.push(
        `- \`${formatMs(error.atMs)}\` ${error.message}${origin}${error.occurrences > 1 ? ` ×${error.occurrences}` : ""}`,
      );
    }
    lines.push("");
  }

  if (failed.length > 0) {
    lines.push("### Evidence — failed requests");
    lines.push("");
    for (const request of failed.slice(0, 5)) {
      lines.push(
        `- \`${formatMs(request.atMs)}\` ${request.method} ${request.url}` +
          (request.status ? ` → HTTP ${request.status}` : " → network error"),
      );
    }
    lines.push("");
  }

  if (mappedOrigins.length > 0) {
    lines.push("### Suspected files");
    lines.push("");
    for (const origin of mappedOrigins.slice(0, 5)) {
      lines.push(`- \`${origin}\``);
    }
    lines.push("");
  }

  if (summary.reproSteps.length > 0) {
    lines.push("### Steps to reproduce");
    lines.push("");
    for (const [index, step] of summary.reproSteps.entries()) {
      const at = step.atMs !== null ? `\`${formatMs(step.atMs)}\` ` : "";
      lines.push(`${index + 1}. ${at}${stepLabel(step)}`);
    }
    lines.push("");
  }

  lines.push("### Suggested next steps");
  lines.push("");
  if (mappedOrigins.length > 0) {
    lines.push(
      "- Open the suspected files above and check the code path that throws the first error.",
    );
  }
  if (firstFailed && firstFailed.status && firstFailed.status >= 500) {
    lines.push(
      "- The earliest failure is a server error — check backend logs for the same window.",
    );
  } else if (firstFailed && firstFailed.status === 404) {
    lines.push(
      "- The earliest failure is a 404 — check for a missing route, asset, or API version.",
    );
  } else if (firstFailed) {
    lines.push("- Inspect the earliest failed request's auth headers and response body.");
  }
  if (errors.length === 0 && failed.length === 0) {
    lines.push(
      "- No console errors or failed requests were captured — record again with console+network surfaces on, or attach the reporter's expected vs actual notes.",
    );
  }
  lines.push("- Open the replay link for full console, network, and DOM evidence.");

  return { verdict, confidence, markdown: lines.join("\n") };
}
