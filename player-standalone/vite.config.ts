import { defineConfig } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Connect } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load base path from env or use default
const basePath = process.env.VITE_BASE_PATH || '/player/';

function createDriveProxyMiddleware(): Connect.NextHandleFunction {
  return async (req, res, next) => {
    if (!req.url || !req.url.startsWith('/api/drive')) {
      next();
      return;
    }

    try {
      const requestUrl = new URL(req.url, 'http://localhost');
      const fileId = requestUrl.searchParams.get('id');

      if (!fileId) {
        res.statusCode = 400;
        res.end('Missing id query parameter');
        return;
      }

      const upstreamUrl = new URL('https://drive.usercontent.google.com/download');
      upstreamUrl.searchParams.set('id', fileId);
      upstreamUrl.searchParams.set('export', 'download');

      const upstreamHeaders = new Headers();
      const range = req.headers.range;
      if (typeof range === 'string' && range) {
        upstreamHeaders.set('range', range);
      }

      const upstreamResponse = await fetch(upstreamUrl.toString(), {
        method: req.method || 'GET',
        headers: upstreamHeaders,
        redirect: 'follow',
      });

      res.statusCode = upstreamResponse.status;
      res.statusMessage = upstreamResponse.statusText;

      for (const headerName of [
        'accept-ranges',
        'cache-control',
        'content-disposition',
        'content-length',
        'content-range',
        'content-type',
        'etag',
        'last-modified',
      ]) {
        const headerValue = upstreamResponse.headers.get(headerName);
        if (headerValue) {
          res.setHeader(headerName, headerValue);
        }
      }

      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('x-content-type-options', 'nosniff');

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
      const message = error instanceof Error ? error.message : 'Unknown proxy error';
      res.statusCode = 502;
      res.end(`Drive proxy error: ${message}`);
    }
  };
}

const driveProxyMiddleware = createDriveProxyMiddleware();

function driveProxyPlugin() {
  return {
    name: 'gn-tracing-drive-proxy',
    configureServer(server: { middlewares: Connect.Server }) {
      server.middlewares.use(driveProxyMiddleware);
    },
    configurePreviewServer(server: { middlewares: Connect.Server }) {
      server.middlewares.use(driveProxyMiddleware);
    },
  };
}

export default defineConfig(({ mode }) => ({
  base: mode === 'production' ? basePath : '/',
  plugins: [driveProxyPlugin()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
      },
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: (assetInfo) => {
          const info = assetInfo.name.split('.');
          const ext = info[info.length - 1];
          if (/\\.(css|js)$/i.test(assetInfo.name)) {
            return `assets/[name]-[hash][extname]`;
          }
          return `assets/[name][extname]`;
        },
      },
    },
  },
  publicDir: 'public',
  server: {
    port: 5173,
    open: true,
  },
}));
