/**
 * Integration tests for the OAuth token-exchange Worker handler.
 *
 * These run inside the Cloudflare Workers pool (see worker/vitest.config.ts) so
 * the handler executes against realistic `Request`/`Response`/env bindings.
 *
 * SECURITY: every env binding here is a synthetic placeholder. No real OAuth
 * client secrets, client ids, or tokens are used. Upstream Google calls are
 * intercepted via a stubbed global `fetch` so no network request is made.
 *
 * Coverage focus (Requirements 1.4, 6.3):
 *  - non-POST requests are rejected with 405
 *  - missing client secret/config yields a 500 server_misconfigured error
 *  - upstream Google responses are relayed/mapped correctly, and upstream
 *    failures map to a 502 upstream_unreachable error
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "./index";

// A synthetic extension origin. With ALLOWED_EXTENSION_ORIGINS empty, any
// `chrome-extension://` origin is accepted by the permissive dev fallback.
const PLACEHOLDER_ORIGIN = "chrome-extension://placeholderextensionidaaaaaaaaaaaaa";

/** Fully-configured placeholder env (synthetic values only). */
function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    GOOGLE_CLIENT_ID: "placeholder-client-id.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "placeholder-client-secret",
    ALLOWED_EXTENSION_ORIGINS: "",
    ...overrides,
  };
}

/** Build a token-exchange POST request with an allowed origin and form body. */
function makeTokenRequest(
  body: Record<string, string> = {
    grant_type: "authorization_code",
    code: "abc",
    code_verifier: "xyz",
  },
  origin: string | null = PLACEHOLDER_ORIGIN,
): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (origin) {
    headers.Origin = origin;
  }
  return new Request("https://proxy.example/token", {
    method: "POST",
    headers,
    body: new URLSearchParams(body).toString(),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("OAuth token proxy - method handling", () => {
  it("rejects GET requests to a non-health path with 405", async () => {
    const res = await worker.fetch(
      new Request("https://proxy.example/token", { method: "GET" }),
      makeEnv(),
    );

    expect(res.status).toBe(405);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("method_not_allowed");
  });

  it("rejects PUT requests with 405", async () => {
    const res = await worker.fetch(
      new Request("https://proxy.example/token", { method: "PUT" }),
      makeEnv(),
    );

    expect(res.status).toBe(405);
  });

  it("serves the unauthenticated health check on GET /health", async () => {
    const res = await worker.fetch(
      new Request("https://proxy.example/health", { method: "GET" }),
      makeEnv(),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; service: string };
    expect(body.ok).toBe(true);
    expect(body.service).toBe("gn-tracing-oauth-proxy");
  });
});

describe("OAuth token proxy - configuration handling", () => {
  it("returns 500 server_misconfigured when the client secret is missing", async () => {
    const res = await worker.fetch(makeTokenRequest(), makeEnv({ GOOGLE_CLIENT_SECRET: "" }));

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("server_misconfigured");
  });

  it("returns 500 server_misconfigured when the client id is missing", async () => {
    const res = await worker.fetch(makeTokenRequest(), makeEnv({ GOOGLE_CLIENT_ID: "" }));

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("server_misconfigured");
  });

  it("rejects a disallowed origin with 403 before touching credentials", async () => {
    const res = await worker.fetch(
      makeTokenRequest({ grant_type: "authorization_code" }, "https://evil.example"),
      makeEnv({ ALLOWED_EXTENSION_ORIGINS: "chrome-extension://only-this-one" }),
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("forbidden_origin");
  });

  it("rejects an unsupported grant_type with 400", async () => {
    const res = await worker.fetch(makeTokenRequest({ grant_type: "password" }), makeEnv());

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unsupported_grant_type");
  });
});

describe("OAuth token proxy - upstream error mapping", () => {
  it("relays a Google error response verbatim with its status", async () => {
    const googleError = { error: "invalid_grant", error_description: "Bad authorization code." };
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(googleError), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const res = await worker.fetch(makeTokenRequest(), makeEnv());

    // Google's status and body are relayed unchanged so the extension's
    // existing error handling keeps working.
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_grant");

    // The Worker injects client_id/client_secret and posts to Google's endpoint.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe("https://oauth2.googleapis.com/token");
    expect(init.method).toBe("POST");
    const forwarded = new URLSearchParams(init.body as string);
    expect(forwarded.get("client_id")).toBe("placeholder-client-id.apps.googleusercontent.com");
    expect(forwarded.get("client_secret")).toBe("placeholder-client-secret");
    expect(forwarded.get("grant_type")).toBe("authorization_code");
  });

  it("relays a successful Google token response verbatim", async () => {
    const tokenPayload = { access_token: "placeholder-access-token", expires_in: 3599 };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(tokenPayload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const res = await worker.fetch(makeTokenRequest(), makeEnv());

    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token: string };
    expect(body.access_token).toBe("placeholder-access-token");
  });

  it("maps an unreachable upstream to 502 upstream_unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const res = await worker.fetch(makeTokenRequest(), makeEnv());

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe("upstream_unreachable");
    expect(body.error_description).toContain("network down");
  });

  it("returns 400 invalid_request for a malformed JSON body", async () => {
    const res = await worker.fetch(
      new Request("https://proxy.example/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: PLACEHOLDER_ORIGIN,
        },
        body: "{not valid json",
      }),
      makeEnv(),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
  });
});
