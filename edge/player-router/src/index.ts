import {
  getReleaseByVersion,
  type ReleaseEntry,
  type ReleaseRegistry,
} from "../../../packages/release-registry/src/index.ts";
import { isProductRouteVersion } from "../../../packages/replay-core/src/route-version.ts";

export interface StoredPlayerObject {
  body: BodyInit | null;
  etag?: string;
  httpMetadata?: { contentType?: string; cacheControl?: string };
}

export interface PlayerArtifactStore {
  get(key: string): Promise<StoredPlayerObject | null>;
}

export interface PlayerProxyHandlers {
  drive(request: Request): Promise<Response>;
  dropbox(request: Request): Promise<Response>;
}

export interface PlayerRouterOptions {
  registry: ReleaseRegistry;
  artifactStore: PlayerArtifactStore;
  proxies: PlayerProxyHandlers;
  legacyVersion?: string;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

/**
 * Resolves only artifacts declared in the append-only release registry.
 * A versioned URL never falls through to a newer Player artifact.
 */
export function createPlayerRouter(options: PlayerRouterOptions) {
  return {
    fetch(request: Request): Promise<Response> {
      return handlePlayerRequest(request, options);
    },
  };
}

async function handlePlayerRequest(
  request: Request,
  options: PlayerRouterOptions,
): Promise<Response> {
  const url = new URL(request.url);
  const route = resolvePlayerRoute(url.pathname, options.registry, options.legacyVersion);
  if (!route.ok) {
    return json(route.status, route.body);
  }

  if (route.remainder === "/api/drive" || route.remainder === "/api/dropbox") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return json(405, { error: "method_not_allowed", error_description: "Use GET or HEAD." });
    }
    const response =
      route.remainder === "/api/drive"
        ? await options.proxies.drive(request)
        : await options.proxies.dropbox(request);
    return withReleaseHeaders(response, route.entry, route.isLegacyAlias);
  }

  const key = objectKeyForRoute(route.entry, route.remainder, request.headers.get("accept"));
  const object = await options.artifactStore.get(key);
  if (!object) {
    return json(404, {
      error: "release_asset_not_found",
      error_description: `Release ${route.entry.version} does not contain ${route.remainder}.`,
    });
  }

  return new Response(object.body, {
    headers: {
      "content-type": object.httpMetadata?.contentType || contentTypeForKey(key),
      "cache-control": object.httpMetadata?.cacheControl || cacheControlForKey(key),
      ...(object.etag ? { etag: object.etag } : {}),
      "x-gn-player-release": route.entry.version,
      ...(route.isLegacyAlias ? { "x-gn-release-alias": "latest" } : {}),
    },
  });
}

function resolvePlayerRoute(
  pathname: string,
  registry: ReleaseRegistry,
  legacyVersion: string | undefined,
):
  | { ok: true; entry: ReleaseEntry; remainder: string; isLegacyAlias: boolean }
  | { ok: false; status: number; body: Record<string, string> } {
  const segments = pathname.split("/").filter(Boolean);
  const first = segments[0] || "";
  const versioned = isProductRouteVersion(first);
  const version = versioned ? first : legacyVersion;

  if (!version) {
    return {
      ok: false,
      status: 404,
      body: {
        error: "release_version_required",
        error_description: "A versioned Player route is required.",
      },
    };
  }

  const entry = getReleaseByVersion(registry, version);
  if (!entry) {
    return {
      ok: false,
      status: 404,
      body: {
        error: "release_not_found",
        error_description: `Player release ${version} is not published.`,
      },
    };
  }

  return {
    ok: true,
    entry,
    remainder: `/${(versioned ? segments.slice(1) : segments).join("/")}`.replace(/\/$/, "") || "/",
    isLegacyAlias: !versioned,
  };
}

function objectKeyForRoute(entry: ReleaseEntry, remainder: string, accept: string | null): string {
  const normalized = remainder.replace(/^\/+/, "");
  if (!normalized || shouldServeSpaIndex(normalized, accept)) {
    return `${entry.player.r2Prefix}index.html`;
  }
  return `${entry.player.r2Prefix}${normalized}`;
}

function shouldServeSpaIndex(path: string, accept: string | null): boolean {
  if (path.startsWith("api/")) {
    return false;
  }
  // Provider replay ids can embed package filenames such as .zip; they are
  // navigation routes, never immutable static-asset keys.
  if (path.startsWith("gdrive/") || path.startsWith("dropbox/")) {
    return true;
  }
  if (path.split("/").at(-1)?.includes(".")) {
    return false;
  }
  return Boolean(accept?.includes("text/html"));
}

function withReleaseHeaders(
  response: Response,
  entry: ReleaseEntry,
  isLegacyAlias: boolean,
): Response {
  const headers = new Headers(response.headers);
  headers.set("x-gn-player-release", entry.version);
  if (isLegacyAlias) {
    headers.set("x-gn-release-alias", "latest");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function json(status: number, body: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function contentTypeForKey(key: string): string {
  if (key.endsWith(".html")) return "text/html; charset=utf-8";
  if (key.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (key.endsWith(".css")) return "text/css; charset=utf-8";
  if (key.endsWith(".json")) return "application/json; charset=utf-8";
  if (key.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

function cacheControlForKey(key: string): string {
  return key.endsWith("index.html") || key.endsWith("release.json")
    ? "no-cache"
    : "public, max-age=31536000, immutable";
}
