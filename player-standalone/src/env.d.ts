/// <reference types="vite/client" />

interface GNTracingConfig {
  mode: 'extension' | 'standalone';
  driveApiKey?: string;
}

declare global {
  interface Window {
    GN_TRACING_CONFIG: GNTracingConfig;
  }
}

// Vite env variables
interface ImportMetaEnv {
  readonly VITE_DRIVE_API_KEY: string | undefined;
  readonly VITE_BASE_PATH: string | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

export {};
