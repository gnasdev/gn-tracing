import { Show } from "solid-js";
import { buildAgentReportMarkdown } from "../../../src/shared/agent-report";
import { t } from "../i18n";
import { session } from "../store/session";

export function ReportPanel() {
  const report = () => session.report as Record<string, unknown> | null;

  async function copyForAi() {
    try {
      if (!session.metadata) {
        return;
      }
      const md = buildAgentReportMarkdown({
        metadata: session.metadata,
        report: session.report,
        console: session.consoleLogs,
        network: session.networkRequests,
        privacy: session.privacy,
        events: session.userEvents,
      });
      await navigator.clipboard.writeText(md);
    } catch (error) {
      console.warn("[player] copy for AI failed", error);
    }
  }

  return (
    <div class="report-panel" id="report-viewer">
      <div class="panel-toolbar">
        <button
          type="button"
          class="btn btn-small"
          id="copy-for-ai-btn"
          onClick={() => void copyForAi()}
        >
          {t("actions.copyForAi") || "Copy for AI"}
        </button>
      </div>
      <Show
        when={report()}
        fallback={
          <div class="empty-hint">
            <p>{t("report.empty") || "No report artifact in this package."}</p>
            <p class="detail-muted">{session.pageUrl || session.recordingId || ""}</p>
          </div>
        }
      >
        {(r) => (
          <div class="report-body">
            <h2>{String(r().title || r().pageTitle || t("report.title") || "Report")}</h2>
            <Show when={r().url || session.pageUrl}>
              <p class="detail-url">{String(r().url || session.pageUrl)}</p>
            </Show>
            <Show when={r().summary || r().description}>
              <p>{String(r().summary || r().description)}</p>
            </Show>
            <pre class="detail-pre">{JSON.stringify(r(), null, 2)}</pre>
          </div>
        )}
      </Show>
      <Show when={session.privacy}>
        <details class="privacy-details">
          <summary>{t("privacy.summary") || "Privacy summary"}</summary>
          <pre class="detail-pre">{JSON.stringify(session.privacy, null, 2)}</pre>
        </details>
      </Show>
    </div>
  );
}
