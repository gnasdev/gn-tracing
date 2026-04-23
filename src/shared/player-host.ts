declare const __APP_ENV__: string;
declare const __PLAYER_HOST_URL__: string;
declare const __PLAYER_LOCAL_PORT__: string;

const APP_ENV = String(typeof __APP_ENV__ === "string" ? __APP_ENV__ : "production").toLowerCase();
const PLAYER_LOCAL_PORT = Number.parseInt(__PLAYER_LOCAL_PORT__ || "5173", 10) || 5173;

export const PLAYER_HOST_URL = APP_ENV === "development"
  ? `http://localhost:${PLAYER_LOCAL_PORT}/`
  : (__PLAYER_HOST_URL__ || "https://tracing.gnas.dev/");

export function buildExternalPlayerUrl(params: URLSearchParams): string {
  const baseUrl = PLAYER_HOST_URL.replace(/\/$/, "");
  return `${baseUrl}/?${params.toString()}`;
}
