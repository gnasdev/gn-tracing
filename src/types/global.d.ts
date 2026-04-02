// Global type declarations for build-time environment variables
// These are injected by esbuild at build time

declare namespace NodeJS {
  interface ProcessEnv {
    GOOGLE_CLIENT_ID: string;
    PLAYER_HOST_URL: string;
  }
}

declare const process: {
  env: NodeJS.ProcessEnv;
};
