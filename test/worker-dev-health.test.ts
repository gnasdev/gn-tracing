import { afterEach, describe, expect, it, vi } from "vitest";
import { isGnTracingOauthWorker } from "../scripts/worker-dev-health.mjs";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isGnTracingOauthWorker", () => {
  it("accepts the GN Tracing OAuth Worker health identity", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, service: "gn-tracing-oauth-proxy" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(isGnTracingOauthWorker()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:63972/health",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("rejects another service even when it reports a generic ok health payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    await expect(isGnTracingOauthWorker()).resolves.toBe(false);
  });

  it("rejects unavailable or malformed health responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 200 })),
    );

    await expect(isGnTracingOauthWorker()).resolves.toBe(false);
  });
});
