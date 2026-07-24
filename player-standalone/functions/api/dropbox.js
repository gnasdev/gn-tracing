/**
 * Cloudflare Pages Function that proxies public Dropbox shared-link downloads.
 *
 * Canonical replay id (from extension after create_shared_link) is the path +
 * essential query of the shared URL without host, e.g.:
 *   scl/fi/abc/file.zip?rlkey=xyz
 *
 * Security: only relative shared-link ids are accepted (s/, scl/, sh/, sm/).
 * Absolute URLs are rejected to prevent open-proxy / SSRF.
 *
 * URL builder: `player-standalone/shared/dropbox-public-url.js` (keep in sync
 * with `src/shared/dropbox-api.ts` unit tests).
 */

import { buildDropboxPublicDownloadUrl } from "../../shared/dropbox-public-url.js";

const FORWARDED_HEADERS = [
  "accept-ranges",
  "content-disposition",
  "content-length",
  "content-range",
  "content-type",
  "etag",
  "last-modified",
];

async function fetchDropboxDownload(replayId, request) {
  const upstreamUrl = buildDropboxPublicDownloadUrl(replayId);
  const upstreamHeaders = new Headers();
  const range = request.headers.get("range");
  if (range) {
    upstreamHeaders.set("range", range);
  }

  return fetch(upstreamUrl, {
    method: "GET",
    headers: upstreamHeaders,
    redirect: "follow",
  });
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const fileId = url.searchParams.get("id");

  if (!fileId) {
    return new Response("Missing id query parameter", { status: 400 });
  }

  let upstreamResponse;
  try {
    upstreamResponse = await fetchDropboxDownload(fileId, context.request);
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

  const responseHeaders = new Headers();
  for (const headerName of FORWARDED_HEADERS) {
    const headerValue = upstreamResponse.headers.get(headerName);
    if (headerValue) {
      responseHeaders.set(headerName, headerValue);
    }
  }

  responseHeaders.set("access-control-allow-origin", "*");
  responseHeaders.set("x-content-type-options", "nosniff");

  const contentType = upstreamResponse.headers.get("content-type") || "";
  if (contentType.toLowerCase().includes("text/html")) {
    responseHeaders.set("cache-control", "no-store");
    return new Response("Dropbox returned an HTML page instead of file bytes.", {
      status: 502,
      headers: responseHeaders,
    });
  }

  responseHeaders.set("cache-control", "public, max-age=86400");

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}
