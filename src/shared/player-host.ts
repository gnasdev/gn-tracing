declare const __APP_ENV__: string;
declare const __PLAYER_LOCAL_PORT__: string;

const APP_ENV = normalizeAppEnv(typeof __APP_ENV__ === "string" ? __APP_ENV__ : "production");
const PLAYER_LOCAL_PORT = Number.parseInt(__PLAYER_LOCAL_PORT__ || "5173", 10) || 5173;
const IS_DEVELOPMENT = APP_ENV === "development";
const PRODUCTION_PLAYER_HOST_URL = "https://tracing.gnas.dev/";

export const PLAYER_HOST_URL = IS_DEVELOPMENT
  ? `http://localhost:${PLAYER_LOCAL_PORT}/`
  : PRODUCTION_PLAYER_HOST_URL;

export function buildExternalPlayerUrl(recordingId: string): string {
  const baseUrl = PLAYER_HOST_URL.replace(/\/$/, "");
  return `${baseUrl}/${encodeURIComponent(recordingId)}`;
}

function normalizeAppEnv(value: string): string {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "dev") return "development";
  if (normalized === "prod") return "production";
  return normalized || "production";
}
