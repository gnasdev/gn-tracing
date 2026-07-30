/**
 * Shared response headers for Drive/Dropbox download proxies.
 */

/** @type {readonly string[]} */
export const FORWARDED_HEADERS = [
  "accept-ranges",
  "content-disposition",
  "content-length",
  "content-range",
  "content-type",
  "etag",
  "last-modified",
];

/**
 * @param {Headers} upstreamHeaders
 * @param {{ htmlFallbackMessage: string }} options
 * @returns {{ headers: Headers; isHtml: boolean; htmlMessage: string }}
 */
export function buildProxyResponseHeaders(upstreamHeaders, options) {
  const headers = new Headers();
  for (const headerName of FORWARDED_HEADERS) {
    const headerValue = upstreamHeaders.get(headerName);
    if (headerValue) {
      headers.set(headerName, headerValue);
    }
  }

  headers.set("access-control-allow-origin", "*");
  headers.set("x-content-type-options", "nosniff");

  const contentType = upstreamHeaders.get("content-type") || "";
  const isHtml = contentType.toLowerCase().includes("text/html");
  if (isHtml) {
    headers.set("cache-control", "no-store");
  } else {
    headers.set("cache-control", "public, max-age=86400");
  }

  return {
    headers,
    isHtml,
    htmlMessage: options.htmlFallbackMessage,
  };
}

/**
 * @param {Response} upstreamResponse
 * @param {{ htmlFallbackMessage: string }} options
 * @returns {Response}
 */
export function toProxyResponse(upstreamResponse, options) {
  const { headers, isHtml, htmlMessage } = buildProxyResponseHeaders(
    upstreamResponse.headers,
    options,
  );

  if (isHtml) {
    return new Response(htmlMessage, {
      status: 502,
      headers,
    });
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  });
}
