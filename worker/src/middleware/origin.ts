/**
 * Origin allow-list checks for OAuth (extension only) and feedback (extension + web).
 */

import {
  type Env,
  isStrictOrigin,
  parseAllowedExtensionOrigins,
  parseAllowedWebOrigins,
} from "../env";

/** OAuth token exchange: extension origins only. */
export function isExtensionOriginAllowed(origin: string | null, env: Env): boolean {
  if (!origin) {
    return false;
  }

  const allowList = parseAllowedExtensionOrigins(env);
  if (allowList.length > 0) {
    return allowList.includes(origin);
  }

  if (isStrictOrigin(env)) {
    return false;
  }

  return origin.startsWith("chrome-extension://");
}

/**
 * Feedback may come from the extension (chrome-extension://) or the hosted
 * standalone player (https://tracing.gnas.dev / local Vite).
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
