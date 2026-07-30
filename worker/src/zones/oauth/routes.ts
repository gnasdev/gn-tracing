/**
 * Path → OAuth provider mapping (includes legacy Google aliases).
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
