import { defineConfig } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load base path from env or use default
const basePath = process.env.VITE_BASE_PATH || '/player/';

export default defineConfig(({ mode }) => ({
  base: mode === 'production' ? basePath : '/',
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
