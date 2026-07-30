import { For, Show } from "solid-js";
import { t } from "../i18n";
import { session } from "../store/session";

export function ScreenshotsPanel() {
  return (
    <div class="screenshots-panel" id="screenshots-viewer">
      <Show
        when={session.screenshotUrls.length > 0}
        fallback={<p class="empty-hint">{t("screenshots.empty") || "No screenshots"}</p>}
      >
        <div class="screenshots-grid" id="screenshots-content">
          <For each={session.screenshotUrls}>
            {(url, index) => (
              <figure class="screenshot-card">
                <img src={url} alt={`Screenshot ${index() + 1}`} />
              </figure>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
