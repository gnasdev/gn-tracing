/**
 * Experimental SolidJS player entry — NOT used by production.
 *
 * Hosted replay ships `index.html` → `src/main.ts` → `public/player.js`
 * (full shell + timeline/network/console). Keep this file for WIP UI work only;
 * do not point `index.html` here until Solid reaches feature parity.
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
