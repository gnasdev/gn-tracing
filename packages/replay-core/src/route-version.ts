/**
 * Product-version route prefixes for Worker and hosted player.
 *
 * Pure helpers (no DOM / chrome / secrets) shared by:
 * - extension parse/emit (`src/shared/*`)
 * - replay-core recording-ref / MCP
 * - Worker path strip
 * - esbuild + deploy scripts (Node imports this .ts via --experimental-strip-types)
 *
 * Path shape:
 *   Worker:  /{version}/token, /{version}/token/dropbox, /{version}/feedback
 *   Player:  /{version}/gdrive/<id>, /{version}/dropbox/<id>
 *
 * Edge accepts any well-formed semver prefix. Unversioned legacy paths stay valid.
 */

/** Core semver MAJOR.MINOR.PATCH (no pre-release / build metadata). */
const PRODUCT_SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function isProductRouteVersion(value: string): boolean {
  return PRODUCT_SEMVER_RE.test(String(value || "").trim());
}

/** Result of stripping an optional `/{MAJOR.MINOR.PATCH}` path prefix. */
export interface StrippedRouteVersion {
  /** Semver prefix when present; null for legacy unversioned paths. */
  routeVersion: string | null;
  /** Path after stripping the version segment (always starts with `/` or is `/`). */
  remainder: string;
}

/**
 * Strips an optional leading `/{MAJOR.MINOR.PATCH}` segment from a pathname.
 */
export function stripRouteVersionPrefix(pathname: string): StrippedRouteVersion {
  const raw = String(pathname || "").trim() || "/";
  const normalized = raw.startsWith("/") ? raw : `/${raw}`;
  const segments = normalized.split("/").filter(Boolean);

  if (segments.length === 0) {
    return { routeVersion: null, remainder: "/" };
  }

  const first = segments[0];
  if (!isProductRouteVersion(first)) {
    return { routeVersion: null, remainder: joinPathSegments(segments) };
  }

  return {
    routeVersion: first,
    remainder: joinPathSegments(segments.slice(1)),
  };
}

/** Joins `/{version}` + remainder path (`/token` → `/1.7.5/token`). */
export function joinVersionedPath(version: string, remainder = "/"): string {
  const ver = String(version || "").trim();
  if (!isProductRouteVersion(ver)) {
    throw new Error(`Invalid product route version: ${version}`);
  }
  const rest = normalizeRemainder(remainder);
  if (rest === "/") {
    return `/${ver}`;
  }
  return `/${ver}${rest}`;
}

/** Worker URLs joined from an origin + product version. */
export interface WorkerEndpoints {
  origin: string;
  googleTokenUrl: string;
  dropboxTokenUrl: string;
  feedbackUrl: string;
  healthUrl: string;
}

/**
 * Resolves Worker endpoint URLs from an env origin (or full legacy URL) plus
 * product version. Secrets may store only the Worker origin; the build joins
 * `/{version}/token` etc.
 */
export function resolveVersionedWorkerEndpoints(
  configuredProxyUrl: string,
  version: string,
): WorkerEndpoints {
  const ver = String(version || "").trim();
  if (!isProductRouteVersion(ver)) {
    throw new Error(`Invalid product route version: ${version}`);
  }

  const raw = String(configuredProxyUrl || "")
    .trim()
    .replace(/\/+$/, "");
  if (!raw) {
    return {
      origin: "",
      googleTokenUrl: "",
      dropboxTokenUrl: "",
      feedbackUrl: "",
      healthUrl: "",
    };
  }

  let origin: string;
  try {
    origin = new URL(raw).origin;
  } catch {
    origin = raw.replace(/\/+$/, "");
    return {
      origin,
      googleTokenUrl: `${origin}/${ver}/token`,
      dropboxTokenUrl: `${origin}/${ver}/token/dropbox`,
      feedbackUrl: `${origin}/${ver}/feedback`,
      healthUrl: `${origin}/${ver}/health`,
    };
  }

  return {
    origin,
    googleTokenUrl: `${origin}/${ver}/token`,
    dropboxTokenUrl: `${origin}/${ver}/token/dropbox`,
    feedbackUrl: `${origin}/${ver}/feedback`,
    healthUrl: `${origin}/${ver}/health`,
  };
}

/**
 * Picks a Worker origin from the first non-empty configured proxy URL.
 */
export function pickWorkerOrigin(...proxyUrls: Array<string | undefined | null>): string {
  for (const value of proxyUrls) {
    const raw = String(value || "")
      .trim()
      .replace(/\/+$/, "");
    if (!raw) {
      continue;
    }
    try {
      return new URL(raw).origin;
    } catch {
      // try next
    }
  }
  return "";
}

function normalizeRemainder(remainder: string): string {
  const raw = String(remainder || "").trim() || "/";
  if (raw === "/") {
    return "/";
  }
  return raw.startsWith("/") ? raw.replace(/\/+$/, "") || "/" : `/${raw.replace(/\/+$/, "")}`;
}

function joinPathSegments(segments: string[]): string {
  if (segments.length === 0) {
    return "/";
  }
  return `/${segments.join("/")}`;
}
