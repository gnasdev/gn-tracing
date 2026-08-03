/**
 * ARCHIVED / DO NOT EXTEND — experimental SolidJS player entry.
 *
 * Production runtime is ONLY:
 *   index.html → src/main.ts → public/player.js (+ vendor/gn-core)
 *
 * This Solid tree (App, panels, store, partial zip load) is not feature-parity
 * and must not receive product features. Do not point Vite/index.html here.
 * Future rewrite (if any) is a cutover project, not incremental dual-maintain.
 *
 * See plan: player architecture extract (monofile → modules, kill dual-stack).
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
console.log("[GN Tracing Player] Mode:", mode, "(SolidJS experimental — not production)");

if (mode === "standalone") {
  setupDriveAdapter();
}

setUiLanguage(getUiLanguage());

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing #root — experimental Solid entry needs a Solid shell HTML");
}

render(() => <App />, root);
