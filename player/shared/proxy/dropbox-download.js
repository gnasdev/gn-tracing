/**
 * Dropbox public shared-link download proxy (relative ids only).
 */

import { buildDropboxPublicDownloadUrl } from "../dropbox-public-url.js";
import { toProxyResponse } from "./headers.js";

/**
 * @param {string} replayId
 * @param {{ method?: string; range?: string | null }} [options]
 * @returns {Promise<Response>}
 */
export async function fetchDropboxDownload(replayId, options = {}) {
  const upstreamUrl = buildDropboxPublicDownloadUrl(replayId);
  const upstreamHeaders = new Headers();
  if (options.range) {
    upstreamHeaders.set("range", options.range);
  }

  return fetch(upstreamUrl, {
    method: options.method || "GET",
    headers: upstreamHeaders,
    redirect: "follow",
  });
}

/**
 * Handle a GET request for `/api/dropbox?id=...`.
 *
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function handleDropboxProxyRequest(request) {
  const url = new URL(request.url);
  const fileId = url.searchParams.get("id");

  if (!fileId) {
    return new Response("Missing id query parameter", { status: 400 });
  }

  try {
    const range = request.headers.get("range");
    const upstreamResponse = await fetchDropboxDownload(fileId, {
      method: request.method || "GET",
      range,
    });
    return toProxyResponse(upstreamResponse, {
      htmlFallbackMessage: "Dropbox returned an HTML page instead of file bytes.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown proxy error";
    // Client-controlled bad ids → 400; other failures → 502.
    const status = /Missing Dropbox|must be a relative|unexpected scheme|shared-link prefix/i.test(
      message,
    )
      ? 400
      : 502;
    return new Response(`Dropbox proxy error: ${message}`, { status });
  }
}
