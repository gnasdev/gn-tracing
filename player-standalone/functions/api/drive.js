const DRIVE_DOWNLOAD_URL = "https://drive.usercontent.google.com/download";
const FORWARDED_HEADERS = [
  "accept-ranges",
  "content-disposition",
  "content-length",
  "content-range",
  "content-type",
  "etag",
  "last-modified",
];

function createDriveDownloadUrl(fileId) {
  const upstreamUrl = new URL(DRIVE_DOWNLOAD_URL);
  upstreamUrl.searchParams.set("id", fileId);
  upstreamUrl.searchParams.set("export", "download");
  return upstreamUrl;
}

function decodeHtmlAttribute(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function extractInputAttributes(inputHtml) {
  const attributes = {};
  const attributePattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match;
  while ((match = attributePattern.exec(inputHtml)) !== null) {
    attributes[match[1].toLowerCase()] = decodeHtmlAttribute(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

function extractFormFields(html) {
  const fields = new URLSearchParams();
  const inputPattern = /<input\b[^>]*>/gi;
  let match;
  while ((match = inputPattern.exec(html)) !== null) {
    const attributes = extractInputAttributes(match[0]);
    if (attributes.name && typeof attributes.value === "string") {
      fields.set(attributes.name, attributes.value);
    }
  }
  return fields;
}

function extractConfirmedDownloadUrl(html, fallbackUrl) {
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

async function fetchDriveDownload(fileId, request) {
  const upstreamUrl = createDriveDownloadUrl(fileId);
  const upstreamHeaders = new Headers();
  const range = request.headers.get("range");
  if (range) {
    upstreamHeaders.set("range", range);
  }

  const initialResponse = await fetch(upstreamUrl.toString(), {
    method: "GET",
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
    method: "GET",
    headers: confirmedHeaders,
    redirect: "follow",
  });
}

/**
 * Cloudflare Pages Function that proxies public Google Drive downloads.
 *
 * The standalone player uses same-origin requests to avoid Drive CORS/CORP
 * restrictions when loading JSON artifacts and video parts from shared files.
 */
export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const fileId = url.searchParams.get("id");

  if (!fileId) {
    return new Response("Missing id query parameter", { status: 400 });
  }

  const upstreamResponse = await fetchDriveDownload(fileId, context.request);

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
    return new Response("Drive returned an HTML confirmation page instead of file bytes.", {
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
