/**
 * Origin allow-list checks for OAuth (extension only) and feedback (extension + web).
 */

import {
  type Env,
  isStrictOrigin,
  parseAllowedExtensionOrigins,
  parseAllowedWebOrigins,
} from "../env";

/** Chromium extension origin scheme (`chrome-extension://<32-char id>`). */
const CHROMIUM_EXTENSION_SCHEME = "chrome-extension://";

/** Firefox extension origin scheme (`moz-extension://<uuid>`). */
const FIREFOX_EXTENSION_SCHEME = "moz-extension://";

/**
 * Allow-list sentinel that accepts any Firefox extension origin.
 *
 * Firefox mints a fresh random `moz-extension://<uuid>` per profile and per
 * install, so — unlike a Chrome extension id — there is no stable origin to pin.
 * Opting in trades the origin check for PKCE plus `redirect_uri` validation
 * (see zones/oauth/redirect-uri.ts), which are the substantive controls anyway.
 */
export const FIREFOX_EXTENSION_ORIGIN_WILDCARD = `${FIREFOX_EXTENSION_SCHEME}*`;

function hasExtensionScheme(origin: string): boolean {
  return (
    origin.startsWith(CHROMIUM_EXTENSION_SCHEME) || origin.startsWith(FIREFOX_EXTENSION_SCHEME)
  );
}

/** OAuth token exchange: extension origins only. */
export function isExtensionOriginAllowed(origin: string | null, env: Env): boolean {
  if (!origin) {
    return false;
  }

  const allowList = parseAllowedExtensionOrigins(env);
  if (allowList.length > 0) {
    if (allowList.includes(origin)) {
      return true;
    }
    return (
      allowList.includes(FIREFOX_EXTENSION_ORIGIN_WILDCARD) &&
      origin.startsWith(FIREFOX_EXTENSION_SCHEME)
    );
  }

  if (isStrictOrigin(env)) {
    return false;
  }

  return hasExtensionScheme(origin);
}

/**
 * Feedback may come from the extension (chrome-extension:// / moz-extension://)
 * or the hosted standalone player (https://tracing.gnas.dev / local Vite).
 */
export function isFeedbackOriginAllowed(origin: string | null, env: Env): boolean {
  if (!origin) {
    return false;
  }
  if (isExtensionOriginAllowed(origin, env)) {
    return true;
  }
  return parseAllowedWebOrigins(env).includes(origin);
}

/** True when OAuth allow-list is empty under STRICT_ORIGIN (server misconfigured). */
export function isOriginAllowListMisconfigured(env: Env): boolean {
  return isStrictOrigin(env) && parseAllowedExtensionOrigins(env).length === 0;
}
