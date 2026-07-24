/**
 * Chooses the replay player host for extension and development builds.
 */
import { buildStorageRecordingPath, type StorageProviderId } from "./storage-provider";

declare const __APP_ENV__: string;
declare const __PLAYER_LOCAL_PORT__: string;

/**
 * Centralized player URL builder.
 *
 * Production recordings always point at the hosted player, while development
 * builds can target the local Vite player. Keeping this in one helper prevents
 * popup/service-worker/offscreen code from drifting on replay URL shape.
 *
 * New uploads emit namespaced paths (`/gdrive/<id>`, `/dropbox/<id>`).
 * Legacy bare Drive ids remain parseable by `parseStorageRecordingRef`.
 */
const APP_ENV = normalizeAppEnv(typeof __APP_ENV__ === "string" ? __APP_ENV__ : "production");
const PLAYER_LOCAL_PORT = Number.parseInt(__PLAYER_LOCAL_PORT__ || "5176", 10) || 5176;
const IS_DEVELOPMENT = APP_ENV === "development";
const PRODUCTION_PLAYER_HOST_URL = "https://tracing.gnas.dev/";

const PLAYER_HOST_URL = IS_DEVELOPMENT
  ? `http://localhost:${PLAYER_LOCAL_PORT}/`
  : PRODUCTION_PLAYER_HOST_URL;

/**
 * Builds a full external replay URL for a recording package file id.
 *
 * @param recordingId - Cloud file / object id returned after upload.
 * @param provider - Active storage provider; defaults to google-drive.
 *   Google Drive always uses `/gdrive/<id>` for newly emitted URLs.
 */
export function buildExternalPlayerUrl(
  recordingId: string,
  provider: StorageProviderId = "google-drive",
): string {
  const baseUrl = PLAYER_HOST_URL.replace(/\/$/, "");
  const path = buildStorageRecordingPath(recordingId, provider);
  if (!path) {
    return `${baseUrl}/`;
  }
  return `${baseUrl}${path}`;
}

/**
 * Resolves a URL for **opening** a replay from the extension UI.
 *
 * Historically rewrote OneDrive `item!`/`u!` links to the extension player.
 * OneDrive support is removed — all URLs pass through unchanged.
 */
export function resolveReplayOpenUrl(recordingUrl: string): string {
  return String(recordingUrl || "").trim();
}

function normalizeAppEnv(value: string): string {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "dev") return "development";
  if (normalized === "prod") return "production";
  return normalized || "production";
}
