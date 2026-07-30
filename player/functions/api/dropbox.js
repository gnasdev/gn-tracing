/**
 * Cloudflare Pages Function that proxies public Dropbox shared-link downloads.
 *
 * Logic lives in `player/shared/proxy/dropbox-download.js` (shared with Vite dev).
 */

import { handleDropboxProxyRequest } from "../../shared/proxy/dropbox-download.js";

export async function onRequestGet(context) {
  return handleDropboxProxyRequest(context.request);
}
