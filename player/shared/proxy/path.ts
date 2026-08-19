import { stripRouteVersionPrefix } from "../../../packages/replay-core/src/route-version.ts";

/**
 * Rejects versioned routes that cannot be represented by the local source Player.
 */
export function isUnsupportedLocalPlayerVersionPath(
  pathname: string,
  currentVersion: string,
): boolean {
  const { routeVersion } = stripRouteVersionPrefix(pathname);
  return routeVersion !== null && routeVersion !== currentVersion;
}

/**
 * Matches only root and current-version storage proxy endpoints before Vite serves SPA fallback HTML.
 */
export function isStorageProxyPath(
  pathname: string,
  endpoint: "drive" | "dropbox",
  currentVersion: string,
): boolean {
  const { remainder, routeVersion } = stripRouteVersionPrefix(pathname);
  return (
    (routeVersion === null || routeVersion === currentVersion) && remainder === `/api/${endpoint}`
  );
}
