/**
 * SolidJS entry for the hosted GN Tracing player.
 */
/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";
import { setupDriveAdapter } from "./drive-adapter";
import { detectMode } from "./extension-detector";
import { getUiLanguage, setUiLanguage } from "./i18n";
import "./styles/app.css";

window.GN_TRACING_CONFIG = {
  mode: "standalone",
  driveApiKey: import.meta.env.VITE_DRIVE_API_KEY || undefined,
  feedbackProxyUrl: import.meta.env.VITE_FEEDBACK_PROXY_URL || undefined,
};

const mode = detectMode();
console.log("[GN Tracing Player] Mode:", mode, "(SolidJS + TypeScript 7)");

if (mode === "standalone") {
  setupDriveAdapter();
}

setUiLanguage(getUiLanguage());

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing #root — check index.html");
}

render(() => <App />, root);
