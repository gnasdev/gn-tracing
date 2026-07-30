/**
 * Cloudflare Pages Function that proxies public Google Drive downloads.
 *
 * Logic lives in `player/shared/proxy/drive-download.js` (shared with Vite dev).
 */

import { handleDriveProxyRequest } from "../../shared/proxy/drive-download.js";

export async function onRequestGet(context) {
  return handleDriveProxyRequest(context.request);
}
