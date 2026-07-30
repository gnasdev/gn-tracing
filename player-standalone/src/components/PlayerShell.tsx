import { For, Match, Show, Switch } from "solid-js";
import { getUiLanguage, language, setUiLanguage, t } from "../i18n";
import { ActivityPanel } from "../panels/ActivityPanel";
import { ConsolePanel } from "../panels/ConsolePanel";
import { NetworkPanel } from "../panels/NetworkPanel";
import { ReportPanel } from "../panels/ReportPanel";
import { ScreenshotsPanel } from "../panels/ScreenshotsPanel";
import { StoragePanel } from "../panels/StoragePanel";
import { type PanelId, session, setSession } from "../store/session";

const TABS: Array<{ id: PanelId; labelKey: string }> = [
  { id: "report", labelKey: "tabs.report" },
  { id: "activity", labelKey: "tabs.activity" },
  { id: "console", labelKey: "tabs.console" },
  { id: "network", labelKey: "tabs.network" },
  { id: "storage", labelKey: "tabs.storage" },
  { id: "screenshots", labelKey: "tabs.screenshots" },
];

export function PlayerShell() {
  void language();

  return (
    <div class="player-state" id="player-state">
      <header class="player-header">
        <div class="player-header-title">
          <strong>GN Tracing</strong>
          <span class="player-header-url">{session.pageUrl || session.recordingId || ""}</span>
        </div>
        <div class="player-header-actions">
          <button
            type="button"
            class="control-btn"
            onClick={() => setUiLanguage(getUiLanguage() === "en" ? "vi" : "en")}
          >
            {getUiLanguage().toUpperCase()}
          </button>
        </div>
      </header>

      <div class="player-layout">
        <section class="media-stage" id="video-section">
          <Show
            when={session.videoUrl}
            fallback={
              <Show
                when={session.screenshotUrls[0]}
                fallback={
                  <div class="no-video-notice" id="no-video-notice">
                    <h2 id="no-video-notice-title">
                      {t("noVideo.title") || "No tab video in this package"}
                    </h2>
                    <p id="no-video-notice-hint">
                      {t("noVideo.hint") ||
                        "Console, network, and other evidence are still available in the tabs."}
                    </p>
                  </div>
                }
              >
                {(url) => (
                  <div class="still-stage" id="still-stage">
                    <img id="still-image" src={url()} alt="Still capture" />
                  </div>
                )}
              </Show>
            }
          >
            {(url) => (
              <div class="video-container" id="video-container">
                {/* Captions not available: recordings are silent tab capture, not spoken dialogue. */}
                <video id="video-player" controls src={url()}>
                  <track kind="captions" />
                </video>
              </div>
            )}
          </Show>
        </section>

        <section class="logs-panel" id="logs-panel">
          <div class="tab-bar" role="tablist">
            <For each={TABS}>
              {(tab) => (
                <button
                  type="button"
                  role="tab"
                  class="tab-btn"
                  id={`${tab.id}-tab`}
                  classList={{ active: session.selectedPanel === tab.id }}
                  aria-selected={session.selectedPanel === tab.id}
                  onClick={() => setSession("selectedPanel", tab.id)}
                >
                  {t(tab.labelKey) || tab.id}
                </button>
              )}
            </For>
          </div>
          <div class="tab-panels">
            <Switch>
              <Match when={session.selectedPanel === "report"}>
                <ReportPanel />
              </Match>
              <Match when={session.selectedPanel === "activity"}>
                <ActivityPanel />
              </Match>
              <Match when={session.selectedPanel === "console"}>
                <ConsolePanel />
              </Match>
              <Match when={session.selectedPanel === "network"}>
                <NetworkPanel />
              </Match>
              <Match when={session.selectedPanel === "storage"}>
                <StoragePanel />
              </Match>
              <Match when={session.selectedPanel === "screenshots"}>
                <ScreenshotsPanel />
              </Match>
            </Switch>
          </div>
        </section>
      </div>
    </div>
  );
}
