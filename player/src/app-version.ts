/**
 * Hosted player adapter for the shared product-version API.
 * Vite bakes `import.meta.env.VITE_APP_VERSION` from root package.json.
 */

import {
  productVersionOrDefault,
  requireProductVersion,
} from "../../packages/replay-core/src/product-version";

function readViteAppVersion(): unknown {
  try {
    return import.meta.env?.VITE_APP_VERSION;
  } catch {
    return undefined;
  }
}

export function getProductVersion(): string {
  return requireProductVersion(readViteAppVersion(), "player");
}

export function getProductVersionOrDefault(fallback = "0.0.0"): string {
  return productVersionOrDefault(readViteAppVersion(), fallback);
}
