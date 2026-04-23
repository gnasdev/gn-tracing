/**
 * Main entry point for standalone player
 */

import { detectMode } from './extension-detector';
import { setupDriveAdapter } from './drive-adapter';

// Set up standalone mode before loading player.js
window.GN_TRACING_CONFIG = {
  mode: 'standalone',
  driveApiKey: import.meta.env.VITE_DRIVE_API_KEY || undefined,
};

async function init() {
  const mode = detectMode();
  console.log('[GN Tracing Player] Mode:', mode);

  if (mode === 'standalone') {
    // Setup Drive adapter for standalone mode
    setupDriveAdapter();
  }

  if (!document.querySelector('script[data-gn-player-script="true"]')) {
    const playerScript = document.createElement('script');
    playerScript.src = '/player.js';
    playerScript.dataset.gnPlayerScript = 'true';
    document.body.appendChild(playerScript);
  }
}

init().catch(console.error);
