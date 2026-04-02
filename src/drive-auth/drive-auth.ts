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

const SERVICE_STATE_KEY = "gn_tracing_state";

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
    successDetail.textContent = "Your Google Drive account is connected.";
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
      updateAuthUI(true);
    } else {
      showState("error");
      errorDetail.textContent = result.error || "Authentication failed. Please try again.";
    }
  } catch (e) {
    showState("error");
    errorDetail.textContent = (e as Error).message || "An unexpected error occurred.";
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
checkStatus();
