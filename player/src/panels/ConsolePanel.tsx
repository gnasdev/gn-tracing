import { For, Show } from "solid-js";
import { t } from "../i18n";
import { session, setSession } from "../store/session";

export function ConsolePanel() {
  const entries = () => session.consoleLogs;
  const selected = () => entries()[session.selectedConsoleIndex];

  return (
    <div class="panel-split console-panel">
      <div class="panel-list">
        <Show
          when={entries().length > 0}
          fallback={<p class="empty-hint">{t("console.empty") || "No console entries"}</p>}
        >
          <For each={entries()}>
            {(entry, index) => (
              <button
                type="button"
                class="list-row"
                classList={{
                  active: index() === session.selectedConsoleIndex,
                  [`level-${entry.level || "log"}`]: true,
                }}
                onClick={() => setSession("selectedConsoleIndex", index())}
              >
                <span class="list-row-level">{String(entry.level || "log")}</span>
                <span class="list-row-text">{formatConsolePreview(entry)}</span>
              </button>
            )}
          </For>
        </Show>
      </div>
      <div class="panel-detail">
        <Show
          when={selected()}
          fallback={<p class="empty-hint">{t("console.select") || "Select an entry"}</p>}
        >
          {(entry) => (
            <div class="detail-block">
              <div class="detail-meta">
                <span>{String(entry().level || "log")}</span>
                <Show when={entry().timestamp}>
                  <span>{formatTime(entry().timestamp)}</span>
                </Show>
              </div>
              <pre class="detail-pre">{formatConsolePreview(entry())}</pre>
              <Show when={entry().stackTrace?.length}>
                <h4>{t("console.stack") || "Stack"}</h4>
                <pre class="detail-pre">
                  {(entry().stackTrace || [])
                    .map((frame) => {
                      const f = frame as {
                        functionName?: string;
                        url?: string;
                        lineNumber?: number;
                      };
                      return `${f.functionName || "(anonymous)"} @ ${f.url || "?"}:${f.lineNumber ?? "?"}`;
                    })
                    .join("\n")}
                </pre>
              </Show>
            </div>
          )}
        </Show>
      </div>
    </div>
  );
}

function formatConsolePreview(entry: { text?: string; args?: unknown[]; level?: string }): string {
  if (typeof entry.text === "string" && entry.text.trim()) {
    return entry.text;
  }
  if (Array.isArray(entry.args) && entry.args.length) {
    return entry.args
      .map((arg) => {
        if (typeof arg === "string") return arg;
        if (arg && typeof arg === "object" && "description" in arg) {
          return String((arg as { description?: string }).description || "");
        }
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      })
      .filter(Boolean)
      .join(" ");
  }
  return String(entry.level || "log");
}

function formatTime(ts: unknown): string {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return "";
  // epoch ms vs relative
  if (ts > 1e12) {
    return new Date(ts).toLocaleTimeString();
  }
  if (ts > 1e9) {
    return new Date(ts * 1000).toLocaleTimeString();
  }
  return `${Math.round(ts)}ms`;
}
