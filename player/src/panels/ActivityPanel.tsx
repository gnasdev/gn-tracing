import { For, Show } from "solid-js";
import { t } from "../i18n";
import { session } from "../store/session";

export function ActivityPanel() {
  const events = () => session.userEvents as Array<Record<string, unknown>>;

  return (
    <div class="activity-panel" id="activity-viewer">
      <Show
        when={events().length > 0}
        fallback={<p class="empty-hint">{t("activity.empty") || "No user events"}</p>}
      >
        <ol class="activity-list">
          <For each={events()}>
            {(event) => (
              <li class="activity-item">
                <span class="activity-type">{String(event.type || event.kind || "event")}</span>
                <span class="activity-detail">
                  {String(event.selector || event.label || event.url || "")}
                </span>
                <Show when={event.relativeMs != null || event.timestamp != null}>
                  <span class="activity-time">{formatMs(event.relativeMs ?? event.timestamp)}</span>
                </Show>
              </li>
            )}
          </For>
        </ol>
      </Show>
    </div>
  );
}

function formatMs(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  if (value > 1e12) return new Date(value).toLocaleTimeString();
  const sec = value > 1e3 ? value / 1000 : value;
  return `${sec.toFixed(1)}s`;
}
