/**
 * Multi-cloud connect page (Google Drive / Dropbox).
 * Opened in a normal tab so OAuth popups are not killed when the extension popup closes.
 */
import { attachFeedbackPopover, type FeedbackUiController } from "../shared/feedback-ui";
import { attachPageNav } from "../shared/page-nav";
import { attachThemeToggle, type ThemeToggleController } from "../shared/theme";
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

const statusByProvider = new Map<StorageProviderId, boolean>();
const busyProviders = new Set<StorageProviderId>();
const errorByProvider = new Map<StorageProviderId, string>();

let currentLanguage: UiLanguage = "en";

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
  render();
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

chrome.storage.session.onChanged.addListener(() => {
  // Best-effort refresh when popup/service worker updates session state.
  void refreshAllStatuses();
});

attachPageNav({ current: "connect" });

const THEME_LABELS = {
  en: {
    system: "System",
    light: "Light",
    dark: "Dark",
    aria: "Theme: {label}",
    titleSystem: "Theme: {label} (follows OS). Click to cycle System → Light → Dark.",
    titleFixed: "Theme: {label}. Click to cycle System → Light → Dark.",
  },
  vi: {
    system: "Hệ thống",
    light: "Sáng",
    dark: "Tối",
    aria: "Giao diện: {label}",
    titleSystem: "Giao diện: {label} (theo OS). Bấm để chuyển Hệ thống → Sáng → Tối.",
    titleFixed: "Giao diện: {label}. Bấm để chuyển Hệ thống → Sáng → Tối.",
  },
} as const;

const themeToggleUi: ThemeToggleController | null = attachThemeToggle(
  "theme-toggle-btn",
  "theme-toggle-icon",
  {
    getLabels: () => THEME_LABELS[currentLanguage] || THEME_LABELS.en,
  },
);

const FEEDBACK_LABELS = {
  en: {
    button: "Feedback",
    sectionAria: "Send feedback",
    label: "Feedback",
    placeholder: "Describe a bug, idea, or question…",
    hint: "Creates a public GitHub issue. Includes extension version, browser, OS, and locale only. Do not include secrets or passwords.",
    submit: "Submit",
    cancel: "Cancel",
    sending: "Sending…",
    success: "Feedback submitted.",
    failed: "Could not submit feedback.",
  },
  vi: {
    button: "Góp ý",
    sectionAria: "Gửi góp ý",
    label: "Góp ý",
    placeholder: "Mô tả lỗi, ý tưởng hoặc câu hỏi…",
    hint: "Tạo issue GitHub công khai. Chỉ kèm version extension, browser, OS và locale. Không gửi mật khẩu hay secret.",
    submit: "Gửi",
    cancel: "Hủy",
    sending: "Đang gửi…",
    success: "Đã gửi góp ý.",
    failed: "Không gửi được góp ý.",
  },
} as const;

const feedbackMount = document.getElementById("feedback-mount");
let feedbackUi: FeedbackUiController | null = null;
if (feedbackMount) {
  feedbackUi = attachFeedbackPopover({
    mount: feedbackMount,
    getLabels: () => FEEDBACK_LABELS[currentLanguage] || FEEDBACK_LABELS.en,
  });
}

currentLanguage = attachLanguageSwitch({
  onChange: (language) => {
    currentLanguage = language;
    applyStaticTranslations();
    feedbackUi?.refreshLabels();
    themeToggleUi?.refreshLabels();
    render();
  },
});
applyStaticTranslations();
feedbackUi?.refreshLabels();
themeToggleUi?.refreshLabels();
render();
void refreshAllStatuses();
