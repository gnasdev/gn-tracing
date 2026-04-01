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

// Start OAuth flow
async function startAuth() {
  showState("loading");

  try {
    const result = await chrome.runtime.sendMessage({ action: "GOOGLE_DRIVE_CONNECT" }) as MessageResponse;

    if (result.ok) {
      showState("success");
      successDetail.textContent = result.message || "Your Google Drive account has been connected successfully.";
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
    const result = await chrome.runtime.sendMessage({ action: "GOOGLE_DRIVE_STATUS" }) as MessageResponse & { isConnected: boolean; email?: string };
    if (result.ok && result.isConnected) {
      showState("success");
      successDetail.textContent = result.email
        ? `Connected as ${result.email}`
        : "Your Google Drive account is already connected.";
    }
  } catch {
    // Ignore errors, stay on initial state
  }
}

// Check status when page loads
checkStatus();
