import {
  getReleaseByVersion,
  type ReleaseRegistry,
} from "../../../packages/release-registry/src/index.ts";
import { isProductRouteVersion } from "../../../packages/replay-core/src/route-version.ts";

export interface VersionWorkerService {
  fetch(request: Request): Promise<Response>;
}

export interface WorkerRouterOptions {
  registry: ReleaseRegistry;
  bindings: Record<string, VersionWorkerService | undefined>;
  legacyVersion?: string;
}

/**
 * Dispatches public versioned Worker routes to the exact release service.
 * The original path remains intact so the immutable Worker can retain its
 * existing version-aware request parsing and diagnostics.
 */
export function createWorkerVersionRouter(options: WorkerRouterOptions) {
  return {
    async fetch(request: Request): Promise<Response> {
      const pathname = new URL(request.url).pathname;
      const first = pathname.split("/").filter(Boolean)[0] || "";
      const isVersioned = isProductRouteVersion(first);
      const version = isVersioned ? first : options.legacyVersion;

      if (!version) {
        return errorResponse(
          404,
          "release_version_required",
          "A versioned Worker route is required.",
        );
      }

      const release = getReleaseByVersion(options.registry, version);
      if (!release) {
        return errorResponse(
          404,
          "release_not_found",
          `Worker release ${version} is not published.`,
        );
      }

      const service = options.bindings[release.worker.bindingName];
      if (!service) {
        return errorResponse(
          503,
          "release_unavailable",
          `Worker release ${version} is not bound to ${release.worker.bindingName}.`,
        );
      }

      const response = await service.fetch(request);
      const headers = new Headers(response.headers);
      headers.set("x-gn-worker-release", version);
      if (!isVersioned) {
        headers.set("x-gn-release-alias", "latest");
      }
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
  };
}

function errorResponse(status: number, error: string, errorDescription: string): Response {
  return new Response(JSON.stringify({ error, error_description: errorDescription }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
