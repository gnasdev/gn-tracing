import { describe, expect, it, vi } from "vitest";
import type { ReleaseRegistry } from "../../../packages/release-registry/src/index";
import { createPlayerRouter, type PlayerArtifactStore } from "./index";

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

function makeStore(objects: Record<string, string>): PlayerArtifactStore {
  return {
    async get(key) {
      const body = objects[key];
      return body === undefined
        ? null
        : { body, etag: `"${key}"`, httpMetadata: { contentType: "text/plain" } };
    },
  };
}

function makeRouter(objects: Record<string, string>, legacyVersion?: string) {
  return createPlayerRouter({
    registry,
    artifactStore: makeStore(objects),
    proxies: {
      drive: vi.fn(async () => new Response("drive-bytes")),
      dropbox: vi.fn(async () => new Response("dropbox-bytes")),
    },
    legacyVersion,
  });
}

describe("Player version router", () => {
  it("serves only the exact versioned static asset", async () => {
    const router = makeRouter({ "player/1.7.11/assets/main.js": "release-111" });
    const response = await router.fetch(
      new Request("https://tracing.gnas.dev/1.7.11/assets/main.js"),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("release-111");
    expect(response.headers.get("x-gn-player-release")).toBe("1.7.11");
  });

  it("uses the matching release index only for replay navigation", async () => {
    const router = makeRouter({ "player/1.7.11/index.html": "release-111-index" });
    const response = await router.fetch(
      new Request("https://tracing.gnas.dev/1.7.11/gdrive/recording-id", {
        headers: { accept: "text/html" },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("release-111-index");
  });

  it("does not convert a missing immutable asset into HTML", async () => {
    const router = makeRouter({ "player/1.7.11/index.html": "index" });
    const response = await router.fetch(
      new Request("https://tracing.gnas.dev/1.7.11/assets/missing.js"),
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: "release_asset_not_found" });
  });

  it("rejects an unregistered version without falling back to latest", async () => {
    const router = makeRouter({ "player/1.7.11/index.html": "index" }, "1.7.11");
    const response = await router.fetch(new Request("https://tracing.gnas.dev/1.7.12/gdrive/id"));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: "release_not_found" });
  });

  it("preserves versioned Drive and Dropbox proxy requests", async () => {
    const router = makeRouter({});
    const response = await router.fetch(
      new Request("https://tracing.gnas.dev/1.7.11/api/drive?id=recording"),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("drive-bytes");
    expect(response.headers.get("x-gn-player-release")).toBe("1.7.11");
  });

  it("serves an explicit latest alias for legacy unversioned paths", async () => {
    const router = makeRouter({ "player/1.7.11/index.html": "legacy-index" }, "1.7.11");
    const response = await router.fetch(
      new Request("https://tracing.gnas.dev/gdrive/legacy", { headers: { accept: "text/html" } }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-gn-release-alias")).toBe("latest");
    expect(await response.text()).toBe("legacy-index");
  });
});
