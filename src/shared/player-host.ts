export const PLAYER_HOST_URL = "https://tracing.gnas.dev/";

export function buildExternalPlayerUrl(params: URLSearchParams): string {
  const baseUrl = PLAYER_HOST_URL.replace(/\/$/, "");
  return `${baseUrl}/?${params.toString()}`;
}
