/**
 * Google Drive public download + large-file virus-scan confirmation handling.
 *
 * Single source of truth for Cloudflare Pages Functions and Vite dev middleware.
 */

import { parseDriveFileId } from "./file-id.js";
import { toProxyResponse } from "./headers.js";

const DRIVE_DOWNLOAD_URL = "https://drive.usercontent.google.com/download";

/**
 * @param {string} fileId
 * @returns {URL}
 */
export function createDriveDownloadUrl(fileId) {
  const upstreamUrl = new URL(DRIVE_DOWNLOAD_URL);
  upstreamUrl.searchParams.set("id", fileId);
  upstreamUrl.searchParams.set("export", "download");
  return upstreamUrl;
}

/**
 * @param {string} value
 * @returns {string}
 */
export function decodeHtmlAttribute(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/**
 * @param {string} inputHtml
 * @returns {Record<string, string>}
 */
export function extractInputAttributes(inputHtml) {
  /** @type {Record<string, string>} */
  const attributes = {};
  const attributePattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match = attributePattern.exec(inputHtml);
  while (match !== null) {
    attributes[match[1].toLowerCase()] = decodeHtmlAttribute(
      match[2] ?? match[3] ?? match[4] ?? "",
    );
    match = attributePattern.exec(inputHtml);
  }
  return attributes;
}

/**
 * @param {string} html
 * @returns {URLSearchParams}
 */
export function extractFormFields(html) {
  const fields = new URLSearchParams();
  const inputPattern = /<input\b[^>]*>/gi;
  let match = inputPattern.exec(html);
  while (match !== null) {
    const attributes = extractInputAttributes(match[0]);
    if (attributes.name && typeof attributes.value === "string") {
      fields.set(attributes.name, attributes.value);
    }
    match = inputPattern.exec(html);
  }
  return fields;
}

/**
 * @param {string} html
 * @param {URL} fallbackUrl
 * @returns {URL | null}
 */
export function extractConfirmedDownloadUrl(html, fallbackUrl) {
  const hrefMatch = html.match(/href=["']([^"']*?[?&]confirm=[^"']*?)["']/i);
  if (hrefMatch) {
    return new URL(decodeHtmlAttribute(hrefMatch[1]), fallbackUrl);
  }

  const formMatch = html.match(/<form\b[^>]*\baction=["']([^"']+)["'][^>]*>/i);
  const formFields = extractFormFields(html);
  if (formFields.has("confirm")) {
    const confirmedUrl = new URL(
      formMatch ? decodeHtmlAttribute(formMatch[1]) : fallbackUrl.toString(),
      fallbackUrl,
    );
    for (const [key, value] of formFields) {
      confirmedUrl.searchParams.set(key, value);
    }
    if (!confirmedUrl.searchParams.has("id")) {
      confirmedUrl.searchParams.set("id", fallbackUrl.searchParams.get("id") || "");
    }
    if (!confirmedUrl.searchParams.has("export")) {
      confirmedUrl.searchParams.set("export", fallbackUrl.searchParams.get("export") || "download");
    }
    return confirmedUrl;
  }

  const confirmMatch = html.match(/[?&]confirm=([0-9A-Za-z_.%-]+)/i);
  if (!confirmMatch) {
    return null;
  }

  const confirmedUrl = new URL(fallbackUrl);
  confirmedUrl.searchParams.set("confirm", decodeURIComponent(confirmMatch[1]));
  const uuidMatch = html.match(/[?&]uuid=([0-9A-Za-z_.%-]+)/i);
  if (uuidMatch) {
    confirmedUrl.searchParams.set("uuid", decodeURIComponent(uuidMatch[1]));
  }
  return confirmedUrl;
}

/**
 * @param {string} fileId
 * @param {{ method?: string; range?: string | null }} [options]
 * @returns {Promise<Response>}
 */
export async function fetchDriveDownload(fileId, options = {}) {
  const method = options.method || "GET";
  const upstreamUrl = createDriveDownloadUrl(fileId);
  const upstreamHeaders = new Headers();
  if (options.range) {
    upstreamHeaders.set("range", options.range);
  }

  const initialResponse = await fetch(upstreamUrl.toString(), {
    method,
    headers: upstreamHeaders,
    redirect: "follow",
  });

  const contentType = initialResponse.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("text/html")) {
    return initialResponse;
  }

  // Large public Drive files can return a virus-scan confirmation HTML page.
  // Resolve that page server-side so the player receives recording bytes.
  const html = await initialResponse.text();
  const confirmedUrl = extractConfirmedDownloadUrl(html, upstreamUrl);
  if (!confirmedUrl) {
    return new Response(html, {
      status: initialResponse.status,
      statusText: initialResponse.statusText,
      headers: initialResponse.headers,
    });
  }

  const confirmedHeaders = new Headers(upstreamHeaders);
  const cookie = initialResponse.headers.get("set-cookie");
  if (cookie) {
    confirmedHeaders.set("cookie", cookie);
  }

  return fetch(confirmedUrl.toString(), {
    method,
    headers: confirmedHeaders,
    redirect: "follow",
  });
}

/**
 * Handle a GET request for `/api/drive?id=...` (Pages Function or Fetch API).
 *
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function handleDriveProxyRequest(request) {
  const url = new URL(request.url);
  const parsed = parseDriveFileId(url.searchParams.get("id") || "");
  if (!parsed.ok) {
    return new Response(parsed.error, { status: 400 });
  }

  try {
    const range = request.headers.get("range");
    const upstreamResponse = await fetchDriveDownload(parsed.id, {
      method: request.method || "GET",
      range,
    });
    return toProxyResponse(upstreamResponse, {
      htmlFallbackMessage: "Drive returned an HTML confirmation page instead of file bytes.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown proxy error";
    return new Response(`Drive proxy error: ${message}`, { status: 502 });
  }
}
