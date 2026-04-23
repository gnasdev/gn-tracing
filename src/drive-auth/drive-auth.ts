import type { MessageResponse } from "../types/messages";

// UI Elements
const initialState = document.getElementById("initial-state")!;
const loadingState = document.getElementById("loading-state")!;
const successState = document.getElementById("success-state")!;
const errorState = document.getElementById("error-state")!;
const connectBtn = document.getElementById("connect-btn") as HTMLButtonElement;
const closeBtn = document.getElementById("close-btn") as HTMLButtonElement;
const retryBtn = document.getElementById("retry-btn") as HTMLButtonElement;
const cancelBtn = document.getElementById("cancel-btn") as HTMLButtonElement;
const successDetail = document.getElementById("success-detail")!;
const errorDetail = document.getElementById("error-detail")!;
const langEnBtn = document.getElementById("lang-en-btn") as HTMLButtonElement;
const langViBtn = document.getElementById("lang-vi-btn") as HTMLButtonElement;

const SERVICE_STATE_KEY = "gn_tracing_state";
const LANGUAGE_STORAGE_KEY = "gn_tracing_drive_auth_language";

type Language = "en" | "vi";
type DetailKind = "connected" | "authFailed" | "unexpectedError" | "authError";

const TEXT: Record<DetailKind, Record<Language, string>> = {
  connected: {
    en: "Your Google Drive is connected. You can go back and upload the recording now.",
    vi: "Google Drive của bạn đã được kết nối. Bây giờ bạn có thể quay lại và tải bản ghi lên.",
  },
  authFailed: {
    en: "Connection was not completed. Please try again.",
    vi: "Kết nối chưa hoàn tất. Vui lòng thử lại.",
  },
  unexpectedError: {
    en: "Something went wrong. Please try again.",
    vi: "Đã có lỗi xảy ra. Vui lòng thử lại.",
  },
  authError: {
    en: "We could not finish connecting to Google Drive.",
    vi: "Không thể hoàn tất kết nối với Google Drive.",
  },
};

let currentLanguage: Language = getInitialLanguage();
let currentErrorMessage: string | null = null;

function getInitialLanguage(): Language {
  const savedLanguage = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
  if (savedLanguage === "en" || savedLanguage === "vi") {
    return savedLanguage;
  }

  return navigator.language.toLowerCase().startsWith("vi") ? "vi" : "en";
}

function translate(kind: DetailKind): string {
  return TEXT[kind][currentLanguage];
}

function applyTranslations(): void {
  const translatableElements = document.querySelectorAll<HTMLElement>("[data-en][data-vi]");
  for (const element of translatableElements) {
    const translation = element.dataset[currentLanguage];
    if (translation) {
      element.textContent = translation;
    }
  }

  document.documentElement.lang = currentLanguage;
  document.title = currentLanguage === "vi"
    ? "Kết nối Google Drive - GN Tracing"
    : "Connect Google Drive - GN Tracing";

  langEnBtn.classList.toggle("active", currentLanguage === "en");
  langViBtn.classList.toggle("active", currentLanguage === "vi");
}

function setLanguage(language: Language): void {
  currentLanguage = language;
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  applyTranslations();

  if (!successState.classList.contains("hidden")) {
    successDetail.textContent = translate("connected");
  }

  if (!errorState.classList.contains("hidden")) {
    errorDetail.textContent = currentErrorMessage || translate("authError");
  }
}

// Show specific state
function showState(state: "initial" | "loading" | "success" | "error") {
  initialState.classList.add("hidden");
  loadingState.classList.add("hidden");
  successState.classList.add("hidden");
  errorState.classList.add("hidden");

  switch (state) {
    case "initial":
      initialState.classList.remove("hidden");
      break;
    case "loading":
      loadingState.classList.remove("hidden");
      break;
    case "success":
      successState.classList.remove("hidden");
      break;
    case "error":
      errorState.classList.remove("hidden");
      break;
  }
}

// Update UI based on auth status
function updateAuthUI(isConnected: boolean) {
  if (isConnected) {
    showState("success");
    successDetail.textContent = translate("connected");
  } else {
    showState("initial");
  }
}

// Start OAuth flow
async function startAuth() {
  showState("loading");

  try {
    const result = await chrome.runtime.sendMessage({ action: "GOOGLE_DRIVE_CONNECT" }) as MessageResponse;

    if (result.ok) {
      currentErrorMessage = null;
      updateAuthUI(true);
    } else {
      showState("error");
      currentErrorMessage = result.error || null;
      errorDetail.textContent = currentErrorMessage || translate("authFailed");
    }
  } catch (e) {
    showState("error");
    const message = (e as Error).message;
    currentErrorMessage = message || null;
    errorDetail.textContent = currentErrorMessage || translate("unexpectedError");
  }
}

// Close window
function closeWindow() {
  window.close();
}

// Event listeners
connectBtn.addEventListener("click", startAuth);
closeBtn.addEventListener("click", closeWindow);
retryBtn.addEventListener("click", () => showState("initial"));
cancelBtn.addEventListener("click", closeWindow);
langEnBtn.addEventListener("click", () => setLanguage("en"));
langViBtn.addEventListener("click", () => setLanguage("vi"));

// Check if already connected on load
async function checkStatus() {
  try {
    const result = await chrome.runtime.sendMessage({ action: "GOOGLE_DRIVE_STATUS" }) as MessageResponse & { isConnected: boolean };
    if (result.ok) {
      updateAuthUI(result.isConnected);
    }
  } catch {
    // Ignore errors, stay on initial state
  }
}

// Listen for state changes from service worker
chrome.storage.session.onChanged.addListener((changes) => {
  if (changes[SERVICE_STATE_KEY]) {
    const newState = changes[SERVICE_STATE_KEY].newValue;
    if (newState?.googleDrive) {
      updateAuthUI(newState.googleDrive.isConnected);
    }
  }
});

// Check status when page loads
applyTranslations();
checkStatus();
