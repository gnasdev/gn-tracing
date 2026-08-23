/**
 * Vite configuration for the hosted standalone replay player.
 *
 * Development mode also provides Drive/Dropbox download proxies so local
 * replay testing exercises the same same-origin path served by the Player router.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Connect } from "vite";
import { defineConfig } from "vite";
import { handleDriveProxyRequest } from "./shared/proxy/drive-download.js";
import { handleDropboxProxyRequest } from "./shared/proxy/dropbox-download.js";
import { isStorageProxyPath, isUnsupportedLocalPlayerVersionPath } from "./shared/proxy/path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootPackageJson = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf-8"),
) as { version?: string };
const rootAppVersion =
  typeof rootPackageJson.version === "string" ? rootPackageJson.version.trim() : "";

// Hosted player is served at the domain root (https://tracing.gnas.dev/).
// Override with VITE_BASE_PATH only when deploying under a subpath.
const basePath = process.env.VITE_BASE_PATH || "/";

/**
 * Adapt a Fetch-API proxy handler to Connect middleware (Vite dev/preview).
 */
function createFetchProxyMiddleware(
  endpoint: "drive" | "dropbox",
  handle: (request: Request) => Promise<Response>,
): Connect.NextHandleFunction {
  return async (req, res, next) => {
    const requestPath = req.url?.split("?")[0] || "";
    if (!isStorageProxyPath(requestPath, endpoint, rootAppVersion)) {
      next();
      return;
    }

    try {
      const host = req.headers.host || "localhost";
      const requestUrl = new URL(req.url, `http://${host}`);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") {
          headers.set(key, value);
        } else if (Array.isArray(value)) {
          headers.set(key, value.join(", "));
        }
      }

      const upstreamResponse = await handle(
        new Request(requestUrl, {
          method: req.method || "GET",
          headers,
        }),
      );

      res.statusCode = upstreamResponse.status;
      res.statusMessage = upstreamResponse.statusText;

      upstreamResponse.headers.forEach((value, key) => {
        res.setHeader(key, value);
      });

      if (!upstreamResponse.body) {
        const text = await upstreamResponse.text();
        res.end(text);
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
      res.end(`Proxy error: ${message}`);
    }
  };
}

const driveProxyMiddleware = createFetchProxyMiddleware("drive", handleDriveProxyRequest);
const dropboxProxyMiddleware = createFetchProxyMiddleware("dropbox", handleDropboxProxyRequest);

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
    urlPath.startsWith("/oauth-callback") ||
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

/**
 * Directory-index resolution for the sub-page static routes, matching
 * `public/_redirects` (production, Cloudflare Pages-only — has no effect in
 * local Vite dev). Without this, `/privacy`, `/terms`, and `/oauth-callback`
 * (no trailing slash, no `.html`) do not resolve to their
 * `public/<name>/index.html` file locally: Vite's static server does not do
 * directory-index fallback for clean URLs on its own, so the request falls
 * through to Vite's SPA catch-all and the player app loads instead — for
 * `/oauth-callback` specifically, the app then misreads the path as a
 * recording id and shows "Invalid Recording Parameters" / "Failed to
 * download file oauth-callback".
 */
const STATIC_SUBPAGES = ["privacy", "terms", "oauth-callback"];

function staticSubpageMiddleware(): Connect.NextHandleFunction {
  return (req, _res, next) => {
    if (!req.url || req.method !== "GET") {
      next();
      return;
    }
    const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    const urlPath = req.url.split("?")[0] || "";
    const trimmed = urlPath.replace(/\/+$/, "");
    if (STATIC_SUBPAGES.includes(trimmed.slice(1))) {
      req.url = `${trimmed}/index.html${query}`;
    }
    next();
  };
}

function unsupportedLocalVersionMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    const requestPath = req.url?.split("?")[0] || "";
    if (!isUnsupportedLocalPlayerVersionPath(requestPath, rootAppVersion)) {
      next();
      return;
    }

    res.statusCode = 404;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        error: "local_release_not_available",
        error_description: `Local Player only serves the current version ${rootAppVersion}.`,
      }),
    );
  };
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
      server.middlewares.use(staticSubpageMiddleware());
      server.middlewares.use(unsupportedLocalVersionMiddleware());
      server.middlewares.use(driveProxyMiddleware);
      server.middlewares.use(dropboxProxyMiddleware);
      server.middlewares.use(playerSpaFallbackMiddleware());
    },
    configurePreviewServer(server: { middlewares: Connect.Server }) {
      server.middlewares.use(staticSubpageMiddleware());
      server.middlewares.use(unsupportedLocalVersionMiddleware());
      server.middlewares.use(driveProxyMiddleware);
      server.middlewares.use(dropboxProxyMiddleware);
      server.middlewares.use(playerSpaFallbackMiddleware());
    },
  };
}

export default defineConfig(({ mode }) => ({
  base: mode === "production" ? basePath : "/",
  plugins: [driveProxyPlugin()],
  // Same product version as extension/worker (root package.json).
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(rootAppVersion),
  },
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "../src/shared"),
      "@replay-core": path.resolve(__dirname, "../packages/replay-core/src"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      input: {
        // Hosted player SPA at domain root. OAuth branding page is static /app/.
        main: path.resolve(__dirname, "index.html"),
      },
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: (assetInfo) => {
          const name = assetInfo.name || "asset";
          if (/\.(css)$/i.test(name)) {
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
    // `task dev` / `task player:dev` should stay in the terminal; open the
    // player manually when needed (http://localhost:5176).
    open: false,
  },
}));
