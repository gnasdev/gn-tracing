/**
 * Vite configuration for the hosted standalone replay player.
 *
 * Development mode also provides a Drive download proxy so local replay testing
 * exercises the same same-origin path used by Cloudflare Pages.
 */

import path from "path";
import { fileURLToPath } from "url";
import type { Connect } from "vite";
import { defineConfig } from "vite";
// Shared with Cloudflare Pages functions — single source for proxy URL allowlists.
import { buildDropboxPublicDownloadUrl } from "./shared/dropbox-public-url.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRIVE_DOWNLOAD_URL = "https://drive.usercontent.google.com/download";
const FORWARDED_DRIVE_HEADERS = [
  "accept-ranges",
  "content-disposition",
  "content-length",
  "content-range",
  "content-type",
  "etag",
  "last-modified",
];

// Hosted player is served at the domain root (https://tracing.gnas.dev/).
// Override with VITE_BASE_PATH only when deploying under a subpath.
const basePath = process.env.VITE_BASE_PATH || "/";

function createDriveDownloadUrl(fileId: string): URL {
  const upstreamUrl = new URL(DRIVE_DOWNLOAD_URL);
  upstreamUrl.searchParams.set("id", fileId);
  upstreamUrl.searchParams.set("export", "download");
  return upstreamUrl;
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function extractInputAttributes(inputHtml: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const attributePattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match: RegExpExecArray | null = attributePattern.exec(inputHtml);
  while (match !== null) {
    attributes[match[1].toLowerCase()] = decodeHtmlAttribute(
      match[2] ?? match[3] ?? match[4] ?? "",
    );
    match = attributePattern.exec(inputHtml);
  }
  return attributes;
}

function extractFormFields(html: string): URLSearchParams {
  const fields = new URLSearchParams();
  const inputPattern = /<input\b[^>]*>/gi;
  let match: RegExpExecArray | null = inputPattern.exec(html);
  while (match !== null) {
    const attributes = extractInputAttributes(match[0]);
    if (attributes.name && typeof attributes.value === "string") {
      fields.set(attributes.name, attributes.value);
    }
    match = inputPattern.exec(html);
  }
  return fields;
}

function extractConfirmedDownloadUrl(html: string, fallbackUrl: URL): URL | null {
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

async function fetchDriveDownload(
  fileId: string,
  method: string,
  range: string | undefined,
): Promise<Response> {
  const upstreamUrl = createDriveDownloadUrl(fileId);
  const upstreamHeaders = new Headers();
  if (range) {
    upstreamHeaders.set("range", range);
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

  // Google Drive may return an HTML confirmation page for large public files.
  // Resolve it in the dev proxy so local testing matches Cloudflare Pages.
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

function createDriveProxyMiddleware(): Connect.NextHandleFunction {
  return async (req, res, next) => {
    if (!req.url || !req.url.startsWith("/api/drive")) {
      next();
      return;
    }

    try {
      const requestUrl = new URL(req.url, "http://localhost");
      const fileId = requestUrl.searchParams.get("id");

      if (!fileId) {
        res.statusCode = 400;
        res.end("Missing id query parameter");
        return;
      }

      const range = req.headers.range;
      const upstreamResponse = await fetchDriveDownload(
        fileId,
        req.method || "GET",
        typeof range === "string" && range ? range : undefined,
      );

      res.statusCode = upstreamResponse.status;
      res.statusMessage = upstreamResponse.statusText;

      for (const headerName of FORWARDED_DRIVE_HEADERS) {
        const headerValue = upstreamResponse.headers.get(headerName);
        if (headerValue) {
          res.setHeader(headerName, headerValue);
        }
      }

      res.setHeader("access-control-allow-origin", "*");
      res.setHeader("x-content-type-options", "nosniff");

      const contentType = upstreamResponse.headers.get("content-type") || "";
      if (contentType.toLowerCase().includes("text/html")) {
        res.statusCode = 502;
        res.setHeader("cache-control", "no-store");
        res.end("Drive returned an HTML confirmation page instead of file bytes.");
        return;
      }

      res.setHeader("cache-control", "public, max-age=86400");

      if (!upstreamResponse.body) {
        res.end();
        return;
      }

      const reader = upstreamResponse.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          res.write(Buffer.from(value));
        }
      }
      res.end();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown proxy error";
      res.statusCode = 502;
      res.end(`Drive proxy error: ${message}`);
    }
  };
}

const driveProxyMiddleware = createDriveProxyMiddleware();

function createDropboxProxyMiddleware(): Connect.NextHandleFunction {
  return async (req, res, next) => {
    if (!req.url || !req.url.startsWith("/api/dropbox")) {
      next();
      return;
    }

    try {
      const requestUrl = new URL(req.url, "http://localhost");
      const fileId = requestUrl.searchParams.get("id");

      if (!fileId) {
        res.statusCode = 400;
        res.end("Missing id query parameter");
        return;
      }

      let upstreamUrl: string;
      try {
        upstreamUrl = buildDropboxPublicDownloadUrl(fileId);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid Dropbox id";
        res.statusCode = 400;
        res.end(`Dropbox proxy error: ${message}`);
        return;
      }

      const range = req.headers.range;
      const upstreamHeaders = new Headers();
      if (typeof range === "string" && range) {
        upstreamHeaders.set("range", range);
      }

      const upstreamResponse = await fetch(upstreamUrl, {
        method: req.method || "GET",
        headers: upstreamHeaders,
        redirect: "follow",
      });

      res.statusCode = upstreamResponse.status;
      res.statusMessage = upstreamResponse.statusText;

      for (const headerName of FORWARDED_DRIVE_HEADERS) {
        const headerValue = upstreamResponse.headers.get(headerName);
        if (headerValue) {
          res.setHeader(headerName, headerValue);
        }
      }

      res.setHeader("access-control-allow-origin", "*");
      res.setHeader("x-content-type-options", "nosniff");

      const contentType = upstreamResponse.headers.get("content-type") || "";
      if (contentType.toLowerCase().includes("text/html")) {
        res.statusCode = 502;
        res.setHeader("cache-control", "no-store");
        res.end("Dropbox returned an HTML page instead of file bytes.");
        return;
      }

      res.setHeader("cache-control", "public, max-age=86400");

      if (!upstreamResponse.body) {
        res.end();
        return;
      }

      const reader = upstreamResponse.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          res.write(Buffer.from(value));
        }
      }
      res.end();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown proxy error";
      res.statusCode = 502;
      res.end(`Dropbox proxy error: ${message}`);
    }
  };
}

const dropboxProxyMiddleware = createDropboxProxyMiddleware();

function shouldRewriteToPlayer(urlPath: string): boolean {
  if (!urlPath || urlPath === "/") return false;
  if (
    urlPath.startsWith("/api/") ||
    urlPath.startsWith("/src/") ||
    urlPath.startsWith("/@") ||
    urlPath.startsWith("/node_modules/") ||
    urlPath.startsWith("/icons/") ||
    urlPath.startsWith("/vendor/") ||
    urlPath.startsWith("/assets/") ||
    urlPath.startsWith("/app") ||
    urlPath.startsWith("/privacy") ||
    urlPath.startsWith("/terms") ||
    urlPath === "/player.js" ||
    urlPath === "/player.css" ||
    urlPath === "/theme.css" ||
    urlPath === "/theme-init.js" ||
    urlPath === "/legal.css"
  ) {
    return false;
  }
  // Paths with a file extension are static assets.
  const last = urlPath.split("/").pop() || "";
  if (last.includes(".")) return false;
  return true;
}

function playerSpaFallbackMiddleware(): Connect.NextHandleFunction {
  return (req, _res, next) => {
    if (!req.url || req.method !== "GET") {
      next();
      return;
    }
    const urlPath = req.url.split("?")[0] || "";
    if (shouldRewriteToPlayer(urlPath)) {
      req.url = `/index.html${req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""}`;
    }
    next();
  };
}

function driveProxyPlugin() {
  return {
    name: "gn-tracing-storage-proxy",
    configureServer(server: { middlewares: Connect.Server }) {
      server.middlewares.use(driveProxyMiddleware);
      server.middlewares.use(dropboxProxyMiddleware);
      server.middlewares.use(playerSpaFallbackMiddleware());
    },
    configurePreviewServer(server: { middlewares: Connect.Server }) {
      server.middlewares.use(driveProxyMiddleware);
      server.middlewares.use(dropboxProxyMiddleware);
      server.middlewares.use(playerSpaFallbackMiddleware());
    },
  };
}

export default defineConfig(({ mode }) => ({
  base: mode === "production" ? basePath : "/",
  plugins: [driveProxyPlugin()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        // Hosted player SPA at domain root. OAuth branding page is static /app/.
        main: path.resolve(__dirname, "index.html"),
      },
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: (assetInfo) => {
          const info = assetInfo.name.split(".");
          const ext = info[info.length - 1];
          if (/\\.(css|js)$/i.test(assetInfo.name)) {
            return `assets/[name]-[hash][extname]`;
          }
          return `assets/[name][extname]`;
        },
      },
    },
  },
  publicDir: "public",
  server: {
    port: 5176,
    open: true,
  },
}));
