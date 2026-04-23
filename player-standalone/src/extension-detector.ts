/**
 * Extension Detector - Detect if running in Chrome Extension context
 */

export function isExtensionContext(): boolean {
  return (
    typeof chrome !== 'undefined' &&
    chrome.runtime !== undefined &&
    typeof chrome.runtime.getURL === 'function'
  );
}

export function detectMode(): 'extension' | 'standalone' {
  if (isExtensionContext()) {
    return 'extension';
  }
  return 'standalone';
}

export function getBaseUrl(): string {
  if (isExtensionContext()) {
    return chrome.runtime.getURL('dist/player/');
  }
  return './';
}

export function getDriveFileUrl(fileId: string): string {
  // For video preview/stream
  return `https://drive.google.com/file/d/${fileId}/preview`;
}

export function getDriveDownloadUrl(fileId: string): string {
  // Standalone player proxies Drive downloads through the same Pages origin to avoid browser CORS/CORP issues.
  return `/api/drive?id=${encodeURIComponent(fileId)}`;
}
