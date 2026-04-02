/**
 * Drive Adapter - Handle data loading from Google Drive
 * Works in both Extension and Standalone modes
 */

import { isExtensionContext, getDriveDownloadUrl } from './extension-detector';

// Declare global for TypeScript
declare global {
  interface Window {
    GN_TRACING_CONFIG: {
      mode: 'extension' | 'standalone';
      driveApiKey?: string;
    };
  }
}

/**
 * Load JSON data from Google Drive
 * Extension mode: Uses service worker with auth token
 * Standalone mode: Uses direct download (may need CORS proxy)
 */
export async function loadDriveJson(fileId: string): Promise<unknown> {
  if (isExtensionContext()) {
    // Extension mode: delegate to service worker
    const response = await chrome.runtime.sendMessage({
      action: 'FETCH_DRIVE_FILE',
      fileId,
    });
    if (!response || !response.ok) {
      throw new Error(response?.error || 'Failed to fetch from Drive');
    }
    return response.data;
  }

  // Standalone mode: fetch directly
  const url = getDriveDownloadUrl(fileId);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  return response.json();
}

/**
 * Load video blob from Google Drive
 * Returns URL that can be used with <video> element
 */
export async function loadDriveVideo(fileId: string): Promise<string> {
  // Use embed URL for both modes - works with Drive's video player
  return `https://drive.google.com/file/d/${fileId}/preview`;
}

/**
 * Get video streaming URL
 * For extension: can use direct download with auth
 * For standalone: use embed/iframe approach
 */
export function getVideoStreamUrl(fileId: string): string {
  // Google Drive video streaming URL
  // Note: This requires the video to be publicly accessible
  return `https://drive.google.com/file/d/${fileId}/preview`;
}

/**
 * Load all recording data from Drive file IDs
 */
export async function loadRecordingData(params: URLSearchParams): Promise<{
  metadata?: unknown;
  consoleData?: unknown[];
  networkData?: unknown[];
  websocketData?: unknown[];
}> {
  const metadataId = params.get('metadata');
  const consoleId = params.get('console');
  const networkId = params.get('network');
  const websocketId = params.get('websocket');

  const result: {
    metadata?: unknown;
    consoleData?: unknown[];
    networkData?: unknown[];
    websocketData?: unknown[];
  } = {};

  if (metadataId) {
    try {
      result.metadata = await loadDriveJson(metadataId);
    } catch (e) {
      console.error('Failed to load metadata:', e);
    }
  }

  if (consoleId) {
    try {
      result.consoleData = await loadDriveJson(consoleId) as unknown[];
    } catch (e) {
      console.error('Failed to load console logs:', e);
    }
  }

  if (networkId) {
    try {
      result.networkData = await loadDriveJson(networkId) as unknown[];
    } catch (e) {
      console.error('Failed to load network logs:', e);
    }
  }

  if (websocketId) {
    try {
      result.websocketData = await loadDriveJson(websocketId) as unknown[];
    } catch (e) {
      console.error('Failed to load websocket logs:', e);
    }
  }

  return result;
}

/**
 * Setup Drive adapter - called before loading player.js
 */
export function setupDriveAdapter(): void {
  // Expose helper functions to window for player.js
  (window as Window & {
    GN_DRIVE_ADAPTER?: {
      loadJson: typeof loadDriveJson;
      loadVideo: typeof loadDriveVideo;
      getStreamUrl: typeof getVideoStreamUrl;
      loadRecording: typeof loadRecordingData;
    };
  }).GN_DRIVE_ADAPTER = {
    loadJson: loadDriveJson,
    loadVideo: loadDriveVideo,
    getStreamUrl: getVideoStreamUrl,
    loadRecording: loadRecordingData,
  };

  // Mark standalone mode
  window.GN_TRACING_CONFIG = {
    mode: 'standalone',
    driveApiKey: import.meta.env.VITE_DRIVE_API_KEY || undefined,
  };
}
