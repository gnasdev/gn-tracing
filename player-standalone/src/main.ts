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

  // Player.js will be loaded by index.html after this module
  // The player.js code will detect the mode and use appropriate loaders
}

init().catch(console.error);
