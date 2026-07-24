/**
 * Multi-cloud connect page (Google Drive / Dropbox).
 * Opened in a normal tab so OAuth popups are not killed when the extension popup closes.
 */
import { attachPageNav } from "../shared/page-nav";
import { attachThemeToggle } from "../shared/theme";
import { attachLanguageSwitch, type UiLanguage } from "../shared/ui-language";
import type { MessageResponse } from "../types/messages";

type StorageProviderId = "google-drive" | "dropbox";

const PROVIDERS: Array<{
  id: StorageProviderId;
  nameEn: string;
  nameVi: string;
}> = [
  { id: "google-drive", nameEn: "Google Drive", nameVi: "Google Drive" },
  { id: "dropbox", nameEn: "Dropbox", nameVi: "Dropbox" },
];

const providerList = document.getElementById("provider-list")!;
const closeBtn = document.getElementById("close-btn") as HTMLButtonElement;
const refreshBtn = document.getElementById("refresh-btn") as HTMLButtonElement;

const statusByProvider = new Map<StorageProviderId, boolean>();
const busyProviders = new Set<StorageProviderId>();
const errorByProvider = new Map<StorageProviderId, string>();

let currentLanguage: UiLanguage = "en";
let highlightProvider: StorageProviderId | null = null;

function providerName(id: StorageProviderId): string {
  const meta = PROVIDERS.find((p) => p.id === id)!;
  return currentLanguage === "vi" ? meta.nameVi : meta.nameEn;
}

function applyStaticTranslations(): void {
  for (const element of document.querySelectorAll<HTMLElement>("[data-en][data-vi]")) {
    const text = element.dataset[currentLanguage];
    if (text) element.textContent = text;
  }
  document.documentElement.lang = currentLanguage;
  document.title =
    currentLanguage === "vi"
      ? "Kết nối lưu trữ đám mây - GN Tracing"
      : "Connect cloud storage - GN Tracing";
}

function parseHighlightFromQuery(): StorageProviderId | null {
  try {
    const raw = new URLSearchParams(location.search).get("provider");
    if (raw === "google-drive" || raw === "dropbox") {
      return raw;
    }
  } catch {
    // ignore
  }
  return null;
}

async function fetchStatus(provider: StorageProviderId): Promise<boolean> {
  const result = (await chrome.runtime.sendMessage({
    action: "STORAGE_STATUS",
    data: { provider },
  })) as MessageResponse & { isConnected?: boolean };
  if (!result?.ok) {
    throw new Error(result?.error || `Could not read ${provider} status.`);
  }
  return Boolean(result.isConnected);
}

async function refreshAllStatuses(): Promise<void> {
  refreshBtn.disabled = true;
  try {
    await Promise.all(
      PROVIDERS.map(async ({ id }) => {
        try {
          const connected = await fetchStatus(id);
          statusByProvider.set(id, connected);
          errorByProvider.delete(id);
        } catch (error) {
          statusByProvider.set(id, false);
          errorByProvider.set(id, (error as Error).message);
        }
      }),
    );
  } finally {
    refreshBtn.disabled = false;
    render();
  }
}

async function connectProvider(provider: StorageProviderId): Promise<void> {
  busyProviders.add(provider);
  errorByProvider.delete(provider);
  render();
  try {
    const result = (await chrome.runtime.sendMessage({
      action: "STORAGE_CONNECT",
      data: { provider },
    })) as MessageResponse;
    if (!result.ok) {
      throw new Error(result.error || `Could not connect ${providerName(provider)}.`);
    }
    statusByProvider.set(provider, true);
    // Prefer this provider after a successful connect.
    await chrome.runtime.sendMessage({
      action: "UPDATE_SETTINGS",
      data: { activeStorageProvider: provider },
    });
  } catch (error) {
    errorByProvider.set(provider, (error as Error).message);
  } finally {
    busyProviders.delete(provider);
    render();
  }
}

async function disconnectProvider(provider: StorageProviderId): Promise<void> {
  busyProviders.add(provider);
  errorByProvider.delete(provider);
  render();
  try {
    const result = (await chrome.runtime.sendMessage({
      action: "STORAGE_DISCONNECT",
      data: { provider },
    })) as MessageResponse;
    if (!result.ok) {
      throw new Error(result.error || `Could not disconnect ${providerName(provider)}.`);
    }
    statusByProvider.set(provider, false);
  } catch (error) {
    errorByProvider.set(provider, (error as Error).message);
  } finally {
    busyProviders.delete(provider);
    render();
  }
}

function render(): void {
  providerList.innerHTML = "";
  for (const { id } of PROVIDERS) {
    const connected = Boolean(statusByProvider.get(id));
    const busy = busyProviders.has(id);
    const error = errorByProvider.get(id);

    const card = document.createElement("div");
    card.className = "provider-card";
    if (highlightProvider === id) {
      card.classList.add("is-highlight");
    }
    card.dataset.provider = id;

    const meta = document.createElement("div");
    meta.className = "meta";

    const name = document.createElement("div");
    name.className = "name";
    name.textContent = providerName(id);

    const status = document.createElement("div");
    status.className = "status";
    if (busy) {
      status.classList.add("is-busy");
      status.textContent = currentLanguage === "vi" ? "Đang xử lý…" : "Working…";
    } else if (error) {
      status.classList.add("is-error");
      status.textContent = error;
    } else if (connected) {
      status.classList.add("is-connected");
      status.textContent = currentLanguage === "vi" ? "Đã kết nối" : "Connected";
    } else {
      status.textContent = currentLanguage === "vi" ? "Chưa kết nối" : "Not connected";
    }

    meta.append(name, status);

    const actions = document.createElement("div");
    actions.className = "actions";

    if (connected) {
      const disconnectBtn = document.createElement("button");
      disconnectBtn.type = "button";
      disconnectBtn.className = "btn btn-small";
      disconnectBtn.disabled = busy;
      disconnectBtn.textContent = currentLanguage === "vi" ? "Ngắt kết nối" : "Disconnect";
      disconnectBtn.addEventListener("click", () => {
        void disconnectProvider(id);
      });
      actions.append(disconnectBtn);
    } else {
      const connectBtn = document.createElement("button");
      connectBtn.type = "button";
      connectBtn.className = "btn btn-start btn-small";
      connectBtn.disabled = busy;
      connectBtn.textContent =
        currentLanguage === "vi" ? `Kết nối ${providerName(id)}` : `Connect ${providerName(id)}`;
      connectBtn.addEventListener("click", () => {
        void connectProvider(id);
      });
      actions.append(connectBtn);
    }

    card.append(meta, actions);
    providerList.append(card);
  }
}

closeBtn.addEventListener("click", () => {
  window.close();
});

refreshBtn.addEventListener("click", () => {
  void refreshAllStatuses();
});

chrome.storage.session.onChanged.addListener(() => {
  // Best-effort refresh when popup/service worker updates session state.
  void refreshAllStatuses();
});

attachThemeToggle("theme-toggle-btn", "theme-toggle-icon");
attachPageNav({ current: "connect" });

currentLanguage = attachLanguageSwitch({
  onChange: (language) => {
    currentLanguage = language;
    applyStaticTranslations();
    render();
  },
});
applyStaticTranslations();
highlightProvider = parseHighlightFromQuery();
render();
void refreshAllStatuses();
