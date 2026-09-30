/**
 * Product (app) version parse/require shared by extension, worker, and player.
 *
 * Source of truth at build time is the monorepo root package.json version.
 * Each surface bakes or loads that string; this module only normalizes and
 * picks among candidates. Core semver rules match route-version prefixes.
 */

import { isProductRouteVersion } from "./route-version";

/**
 * Trim and accept only core MAJOR.MINOR.PATCH. Returns null when invalid.
 */
export function parseProductVersion(raw: unknown): string | null {
  if (raw == null) {
    return null;
  }
  const value = String(raw).trim();
  return isProductRouteVersion(value) ? value : null;
}

/**
 * First valid product version among candidates, or null.
 */
export function pickProductVersion(...candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    const parsed = parseProductVersion(candidate);
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

/**
 * Require a valid product version. `label` identifies the surface in errors
 * (e.g. "extension", "worker", "player").
 */
export function requireProductVersion(raw: unknown, label = "product"): string {
  const parsed = parseProductVersion(raw);
  if (parsed) {
    return parsed;
  }
  throw new Error(
    `Missing or invalid ${label} version (got ${JSON.stringify(raw == null ? undefined : String(raw))}). ` +
      "Expected core semver MAJOR.MINOR.PATCH from root package.json (baked at build or synced package).",
  );
}

/**
 * Soft default for metadata/fixtures only — not for emit URLs that must be versioned.
 */
export function productVersionOrDefault(raw: unknown, fallback = "0.0.0"): string {
  return parseProductVersion(raw) ?? fallback;
}
