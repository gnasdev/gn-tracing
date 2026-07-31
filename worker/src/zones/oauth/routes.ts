/**
 * Path → OAuth provider mapping (includes legacy Google aliases).
 *
 * Callers must pass the path *after* stripping an optional product-version
 * prefix (`/1.7.5/token` → `/token`). See `stripRouteVersionPrefix`.
 */

import type { OAuthProviderId } from "./providers";

/** Map request path to provider. Empty / legacy paths default to Google. */
export function resolveProviderFromPath(pathname: string): OAuthProviderId | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  switch (path) {
    case "/":
    case "/token":
    case "/token/google":
    case "/google":
      return "google";
    case "/token/dropbox":
    case "/dropbox":
      return "dropbox";
    default:
      return null;
  }
}
