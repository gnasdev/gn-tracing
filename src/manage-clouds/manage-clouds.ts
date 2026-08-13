/**
 * Manage clouds extension page — connect/disconnect Google Drive and Dropbox.
 * Survives popup close during OAuth (full tab surface).
 */

import { buttonSpinnerHtml } from "../shared/button-loading";
import { attachLanguageSwitch, type UiLanguage } from "../shared/ui-language";
import { attachThemePreferenceInputs, type ThemePreference } from "../shared/theme";
import { escapeHtml } from "../shared/upload-history-ui";
import type { MessageResponse } from "../types/messages";
import {
  buildProviderRowModel,
  type CloudProviderId,
  isProviderConnected,
  MANAGE_CLOUDS_PROVIDERS,
  storageProviderDisplayName,
  storageProviderMessage,
} from "./page-model";

type Lang = UiLanguage;

const COPY: Record<Lang, Record<string, string>> = {
  en: {
    "storage.manageCloudsTitle": "Manage clouds",
    "storage.manageCloudsLead":
      "Connect Google Drive or Dropbox. The extension can only access files it uploads — not your full cloud drive. This page stays open during OAuth so you can finish sign-in without losing status.",
    "storage.connected": "Connected",
    "storage.notConnectedStatus": "Not connected",
    "storage.working": "Working…",
    "storage.disconnect": "Disconnect",
    "storage.connectProvider": "Connect {name}",
    "storage.notConnected": "{name} is not connected.",
    "storage.switchFailed": "Could not switch storage provider.",
    "page.documentTitle": "Manage clouds — GN Tracing",
  },
  vi: {
    "storage.manageCloudsTitle": "Quản lý cloud",
    "storage.manageCloudsLead":
      "Kết nối Google Drive hoặc Dropbox. Extension chỉ truy cập file do chính nó upload — không đọc toàn bộ cloud. Trang này giữ mở trong OAuth để bạn hoàn tất đăng nhập mà không mất trạng thái.",
    "storage.connected": "Đã kết nối",
    "storage.notConnectedStatus": "Chưa kết nối",
    "storage.working": "Đang xử lý…",
    "storage.disconnect": "Ngắt kết nối",
    "storage.connectProvider": "Kết nối {name}",
    "storage.notConnected": "{name} chưa được kết nối.",
    "storage.switchFailed": "Không chuyển được nhà cung cấp lưu trữ.",
    "page.documentTitle": "Quản lý cloud — GN Tracing",
  },
};

let lang: Lang = "en";

function t(key: string, vars?: Record<string, string>): string {
  let text = COPY[lang][key] ?? COPY.en[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replaceAll(`{${k}}`, v);
    }
  }
  return text;
}

function applyI18n(): void {
  document.title = t("page.documentTitle");
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    if (key) {
      el.textContent = t(key);
    }
  });
}

const providerList = document.getElementById("provider-list");
const connected = new Map<CloudProviderId, boolean>([
  ["google-drive", false],
  ["dropbox", false],
]);
const busy = new Set<CloudProviderId>();
const errors = new Map<CloudProviderId, string>();

function rowCopy() {
  return {
    connected: t("storage.connected"),
    notConnected: t("storage.notConnectedStatus"),
    working: t("storage.working"),
    disconnect: t("storage.disconnect"),
    connectProvider: (name: string) => t("storage.connectProvider", { name }),
  };
}

function renderProviderList(): void {
  if (!providerList) {
    return;
  }
  providerList.innerHTML = "";
  for (const id of MANAGE_CLOUDS_PROVIDERS) {
    const model = buildProviderRowModel(id, {
      connected: Boolean(connected.get(id)),
      busy: busy.has(id),
      error: errors.get(id) ?? null,
      copy: rowCopy(),
    });

    const card = document.createElement("div");
    card.className = "mc-provider-card";
    card.dataset.provider = id;
    card.setAttribute("role", "listitem");

    const meta = document.createElement("div");
    meta.className = "meta";
    const nameEl = document.createElement("div");
    nameEl.className = "name";
    nameEl.textContent = model.name;
    const statusEl = document.createElement("div");
    statusEl.className = "status";
    if (model.statusKind === "busy") {
      statusEl.classList.add("is-busy");
      statusEl.innerHTML = `${buttonSpinnerHtml()}<span>${escapeHtml(model.statusText)}</span>`;
    } else if (model.statusKind === "error") {
      statusEl.classList.add("is-error");
      statusEl.textContent = model.statusText;
    } else if (model.statusKind === "connected") {
      statusEl.classList.add("is-connected");
      statusEl.textContent = model.statusText;
    } else {
      statusEl.textContent = model.statusText;
    }
    meta.append(nameEl, statusEl);

    const actions = document.createElement("div");
    actions.className = "actions";
    const actionBtn = document.createElement("button");
    actionBtn.type = "button";
    actionBtn.className = model.actionIsPrimary
      ? "btn btn-start btn-small"
      : "btn btn-secondary btn-small";
    actionBtn.disabled = model.busy;
    actionBtn.textContent = model.actionLabel;
    actionBtn.addEventListener("click", () => {
      if (model.connected) {
        void disconnectProvider(id);
      } else {
        void connectProvider(id);
      }
    });
    actions.append(actionBtn);
    card.append(meta, actions);
    providerList.append(card);
  }
}

async function refreshAllStatuses(): Promise<void> {
  await Promise.all(
    MANAGE_CLOUDS_PROVIDERS.map(async (provider) => {
      try {
        const result = (await chrome.runtime.sendMessage(
          storageProviderMessage("STORAGE_STATUS", provider),
        )) as MessageResponse & { isConnected?: boolean };
        connected.set(provider, isProviderConnected(result));
      } catch {
        connected.set(provider, false);
      }
    }),
  );
  renderProviderList();
}

async function connectProvider(provider: CloudProviderId): Promise<void> {
  busy.add(provider);
  errors.delete(provider);
  renderProviderList();
  try {
    const result = (await chrome.runtime.sendMessage(
      storageProviderMessage("STORAGE_CONNECT", provider),
    )) as MessageResponse;
    if (!result.ok) {
      throw new Error(
        result.error || t("storage.notConnected", { name: storageProviderDisplayName(provider) }),
      );
    }
    connected.set(provider, true);
    await chrome.runtime.sendMessage({
      action: "UPDATE_SETTINGS",
      data: { activeStorageProvider: provider },
    });
    await refreshAllStatuses();
  } catch (error) {
    errors.set(provider, error instanceof Error ? error.message : String(error));
    connected.set(provider, false);
  } finally {
    busy.delete(provider);
    renderProviderList();
  }
}

async function disconnectProvider(provider: CloudProviderId): Promise<void> {
  busy.add(provider);
  errors.delete(provider);
  renderProviderList();
  try {
    const result = (await chrome.runtime.sendMessage(
      storageProviderMessage("STORAGE_DISCONNECT", provider),
    )) as MessageResponse;
    if (!result.ok) {
      throw new Error(result.error || t("storage.switchFailed"));
    }
    connected.set(provider, false);
    await refreshAllStatuses();
  } catch (error) {
    errors.set(provider, error instanceof Error ? error.message : String(error));
  } finally {
    busy.delete(provider);
    renderProviderList();
  }
}

function wireLanguage(): void {
  lang = attachLanguageSwitch({
    onChange: (next) => {
      lang = next;
      applyI18n();
      renderProviderList();
    },
  });
}

const THEME_CYCLE: ThemePreference[] = ["system", "light", "dark"];
const THEME_ICONS: Record<ThemePreference, string> = {
  system: "ph-desktop",
  light: "ph-sun",
  dark: "ph-moon",
};
const THEME_LABELS: Record<ThemePreference, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

function syncThemeToggleUi(): void {
  const btn = document.getElementById("theme-toggle-btn");
  const icon = document.getElementById("theme-toggle-icon");
  if (!btn || !icon) {
    return;
  }
  const preference = document.documentElement.getAttribute("data-theme-preference");
  const normalized: ThemePreference =
    preference === "light" || preference === "dark" ? preference : "system";
  icon.className = `ph ${THEME_ICONS[normalized]}`;
  const label = `Theme: ${THEME_LABELS[normalized]}`;
  btn.setAttribute("aria-label", label);
  btn.title = label;
}

function wireTheme(): void {
  const controller = attachThemePreferenceInputs({
    system: "theme-system-input",
    light: "theme-light-input",
    dark: "theme-dark-input",
  });
  if (!controller) {
    return;
  }

  document.getElementById("theme-toggle-btn")?.addEventListener("click", () => {
    const current = controller.getPreference();
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(current) + 1) % THEME_CYCLE.length];
    void controller.setPreference(next);
  });

  new MutationObserver(syncThemeToggleUi).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme-preference"],
  });
  syncThemeToggleUi();
}

function wireChrome(): void {
  // Re-read connection state after OAuth returns focus to this tab.
  window.addEventListener("focus", () => {
    void refreshAllStatuses();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void refreshAllStatuses();
    }
  });
}

wireLanguage();
applyI18n();
wireTheme();
wireChrome();
renderProviderList();
void refreshAllStatuses();
