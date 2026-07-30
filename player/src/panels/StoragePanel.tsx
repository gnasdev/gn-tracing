import { For, Show } from "solid-js";
import { t } from "../i18n";
import { session } from "../store/session";

export function StoragePanel() {
  const artifact = () => session.storageArtifact;

  return (
    <div class="storage-panel" id="storage-viewer">
      <Show
        when={artifact()}
        fallback={<p class="empty-hint">{t("storage.empty") || "No storage snapshots"}</p>}
      >
        {(art) => (
          <div class="storage-groups">
            <For each={normalizeSnapshots(art())}>
              {(snap) => (
                <section class="storage-group">
                  <h3>
                    {snap.label} — {snap.phase}
                  </h3>
                  <Show when={snap.localStorage?.length}>
                    <h4>localStorage</h4>
                    <ul class="kv-list">
                      <For each={snap.localStorage}>
                        {(item) => (
                          <li>
                            <code>{item.key}</code>
                            <span>{item.value}</span>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                  <Show when={snap.sessionStorage?.length}>
                    <h4>sessionStorage</h4>
                    <ul class="kv-list">
                      <For each={snap.sessionStorage}>
                        {(item) => (
                          <li>
                            <code>{item.key}</code>
                            <span>{item.value}</span>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                </section>
              )}
            </For>
          </div>
        )}
      </Show>
    </div>
  );
}

function normalizeSnapshots(artifact: unknown): Array<{
  label: string;
  phase: string;
  localStorage?: Array<{ key: string; value: string }>;
  sessionStorage?: Array<{ key: string; value: string }>;
}> {
  if (!artifact || typeof artifact !== "object") return [];
  const raw = artifact as { snapshots?: unknown[]; start?: unknown; stop?: unknown };
  if (Array.isArray(raw.snapshots)) {
    return raw.snapshots.map((snap, i) => {
      const s = snap as Record<string, unknown>;
      return {
        label: String(s.label || `Snapshot ${i + 1}`),
        phase: String(s.phase || s.kind || ""),
        localStorage: s.localStorage as Array<{ key: string; value: string }> | undefined,
        sessionStorage: s.sessionStorage as Array<{ key: string; value: string }> | undefined,
      };
    });
  }
  return [];
}
