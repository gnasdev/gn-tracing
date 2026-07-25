/**
 * Ambient Vite and window globals used by the standalone player build.
 */
/// <reference types="vite/client" />

interface GNTracingConfig {
  mode: "extension" | "standalone";
  driveApiKey?: string;
  /** POST endpoint for opt-in product feedback (Worker /feedback). */
  feedbackProxyUrl?: string;
}

declare global {
  interface Window {
    GN_TRACING_CONFIG: GNTracingConfig;
  }

  interface ImportMetaEnv {
    readonly VITE_DRIVE_API_KEY: string | undefined;
    readonly VITE_BASE_PATH: string | undefined;
    readonly VITE_FEEDBACK_PROXY_URL: string | undefined;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

export {};
