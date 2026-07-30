import { createMemo, For, Show } from "solid-js";
import {
  getNetworkFilterType,
  type NetworkFilterBucket,
} from "../../../src/shared/network-filter-type";
import { t } from "../i18n";
import { session, setSession } from "../store/session";

const FILTERS: Array<{ id: string; labelKey: string }> = [
  { id: "all", labelKey: "network.filterAll" },
  { id: "fetch", labelKey: "network.filterFetch" },
  { id: "js", labelKey: "network.filterJs" },
  { id: "css", labelKey: "network.filterCss" },
  { id: "img", labelKey: "network.filterImg" },
  { id: "media", labelKey: "network.filterMedia" },
  { id: "font", labelKey: "network.filterFont" },
  { id: "doc", labelKey: "network.filterDoc" },
  { id: "ws", labelKey: "network.filterWs" },
  { id: "other", labelKey: "network.filterOther" },
];

export function NetworkPanel() {
  const filtered = createMemo(() => {
    const filter = session.networkFilter;
    const rows = session.networkRequests;
    if (filter === "all") return rows;
    return rows.filter((entry) => {
      const resourceType =
        typeof (entry as { type?: string }).type === "string"
          ? (entry as { type?: string }).type
          : typeof (entry as { resourceType?: string }).resourceType === "string"
            ? (entry as { resourceType?: string }).resourceType
            : undefined;
      const bucket = getNetworkFilterType({
        url: entry.url,
        mimeType: entry.mimeType || entry.responseHeaders?.["content-type"],
        resourceType,
      }) as NetworkFilterBucket;
      return bucket === filter;
    });
  });

  const selected = () => filtered()[session.selectedNetworkIndex] || filtered()[0];

  return (
    <div class="network-panel">
      <div class="network-filters" id="network-filters">
        <For each={FILTERS}>
          {(filter) => (
            <button
              type="button"
              class="filter-chip"
              data-filter={filter.id}
              classList={{ active: session.networkFilter === filter.id }}
              onClick={() => {
                setSession("networkFilter", filter.id);
                setSession("selectedNetworkIndex", 0);
              }}
            >
              {t(filter.labelKey) || filter.id}
            </button>
          )}
        </For>
      </div>
      <div class="panel-split">
        <div class="panel-list">
          <Show
            when={filtered().length > 0}
            fallback={<p class="empty-hint">{t("network.empty") || "No network entries"}</p>}
          >
            <For each={filtered()}>
              {(entry, index) => (
                <button
                  type="button"
                  class="list-row"
                  classList={{
                    active: index() === session.selectedNetworkIndex,
                    failed: isFailed(entry.status),
                  }}
                  onClick={() => setSession("selectedNetworkIndex", index())}
                >
                  <span class="list-row-status">{entry.status ?? "—"}</span>
                  <span class="list-row-method">{entry.method || "GET"}</span>
                  <span class="list-row-text">{shortUrl(entry.url)}</span>
                </button>
              )}
            </For>
          </Show>
        </div>
        <div class="panel-detail">
          <Show
            when={selected()}
            fallback={<p class="empty-hint">{t("network.select") || "Select a request"}</p>}
          >
            {(entry) => (
              <div class="detail-block">
                <div class="detail-meta">
                  <strong>
                    {entry().method || "GET"} {entry().status ?? "—"}
                  </strong>
                </div>
                <p class="detail-url">{entry().url}</p>
                <Show when={entry().mimeType}>
                  <p class="detail-muted">{entry().mimeType}</p>
                </Show>
                <Show when={entry().postData}>
                  <h4>{t("network.requestBody") || "Request body"}</h4>
                  <pre class="detail-pre">{String(entry().postData)}</pre>
                </Show>
                <Show when={entry().responseBody}>
                  <h4>{t("network.responseBody") || "Response body"}</h4>
                  <pre class="detail-pre">{String(entry().responseBody)}</pre>
                </Show>
              </div>
            )}
          </Show>
        </div>
      </div>
    </div>
  );
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`.slice(0, 120) || url;
  } catch {
    return url.slice(0, 120);
  }
}

function isFailed(status: number | null | undefined): boolean {
  return typeof status === "number" && status >= 400;
}
