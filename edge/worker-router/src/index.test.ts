import { describe, expect, it, vi } from "vitest";
import type { ReleaseRegistry } from "../../../packages/release-registry/src/index";
import { createWorkerVersionRouter } from "./index";

const registry: ReleaseRegistry = {
  schemaVersion: 1,
  releases: [
    {
      version: "1.7.11",
      sourceCommit: "a123456",
      player: {
        r2Prefix: "player/1.7.11/",
        sha256: `sha256:${"a".repeat(64)}`,
        builtAt: "2026-08-19T00:00:00.000Z",
      },
      worker: {
        serviceName: "gn-tracing-oauth-proxy-v1-7-11",
        bindingName: "WORKER_1_7_11",
        sourceCommit: "a123456",
      },
    },
  ],
};

function makeRouter(
  bindings: Record<string, { fetch(request: Request): Promise<Response> } | undefined>,
) {
  return createWorkerVersionRouter({ registry, bindings, legacyVersion: "1.7.11" });
}

describe("Worker version router", () => {
  it("dispatches a versioned request to its exact immutable binding without rewriting the path", async () => {
    const fetch = vi.fn(async () => new Response("worker-111"));
    const router = makeRouter({ WORKER_1_7_11: { fetch } });
    const request = new Request("https://proxy.example/1.7.11/feedback", { method: "POST" });
    const response = await router.fetch(request);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("worker-111");
    expect(response.headers.get("x-gn-worker-release")).toBe("1.7.11");
    expect(fetch).toHaveBeenCalledWith(request);
  });

  it("never routes an unknown version to the legacy latest service", async () => {
    const router = makeRouter({ WORKER_1_7_11: { fetch: vi.fn() } });
    const response = await router.fetch(new Request("https://proxy.example/1.7.12/health"));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: "release_not_found" });
  });

  it("marks the explicit legacy alias while routing it to the configured version", async () => {
    const router = makeRouter({ WORKER_1_7_11: { fetch: async () => new Response("legacy") } });
    const response = await router.fetch(new Request("https://proxy.example/health"));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-gn-worker-release")).toBe("1.7.11");
    expect(response.headers.get("x-gn-release-alias")).toBe("latest");
  });

  it("fails closed when a declared release binding is unavailable", async () => {
    const router = makeRouter({});
    const response = await router.fetch(new Request("https://proxy.example/1.7.11/health"));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: "release_unavailable" });
  });
});
