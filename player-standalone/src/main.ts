/**
 * Main entry point for standalone player.
 *
 * It installs the hosted-player configuration and Drive adapter before loading
 * the shared player runtime.
 */

import { setupDriveAdapter } from "./drive-adapter";
// Configure browser globals before importing the shared player runtime because
// `player/player.js` reads them during startup.
import { detectMode } from "./extension-detector";

// Set up standalone mode before loading player.js
window.GN_TRACING_CONFIG = {
  mode: "standalone",
  driveApiKey: import.meta.env.VITE_DRIVE_API_KEY || undefined,
};

async function init() {
  const mode = detectMode();
  console.log("[GN Tracing Player] Mode:", mode);

  if (mode === "standalone") {
    // Setup Drive adapter for standalone mode
    setupDriveAdapter();
  }

  if (!document.querySelector('script[data-gn-player-script="true"]')) {
    const playerScript = document.createElement("script");
    playerScript.src = "/player.js";
    playerScript.dataset.gnPlayerScript = "true";
    document.body.appendChild(playerScript);
  }
}

init().catch(console.error);
