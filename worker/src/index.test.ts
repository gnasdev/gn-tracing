/**
 * Integration tests for the multi-issuer OAuth token-exchange Worker handler.
 *
 * SECURITY: every env binding is a synthetic placeholder. Upstream provider
 * calls are intercepted via stubbed global `fetch` — no real network.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env, resolveProviderFromPath } from "./index";

const PLACEHOLDER_ORIGIN = "chrome-extension://placeholderextensionidaaaaaaaaaaaaa";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    GOOGLE_CLIENT_ID: "placeholder-client-id.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "placeholder-google-secret",
    DROPBOX_CLIENT_ID: "placeholder-dropbox-app-key",
    DROPBOX_CLIENT_SECRET: "placeholder-dropbox-secret",
    ALLOWED_EXTENSION_ORIGINS: "",
    ...overrides,
  };
}

function makeTokenRequest(
  path: string,
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
  return new Request(`https://proxy.example${path}`, {
    method: "POST",
    headers,
    body: new URLSearchParams(body).toString(),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("resolveProviderFromPath", () => {
  it("maps legacy Google paths and explicit provider paths", () => {
    expect(resolveProviderFromPath("/")).toBe("google");
    expect(resolveProviderFromPath("/token")).toBe("google");
    expect(resolveProviderFromPath("/token/google")).toBe("google");
    expect(resolveProviderFromPath("/token/dropbox")).toBe("dropbox");
    expect(resolveProviderFromPath("/dropbox")).toBe("dropbox");
    expect(resolveProviderFromPath("/token/onedrive")).toBeNull();
    expect(resolveProviderFromPath("/unknown")).toBeNull();
  });
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

  it("serves the unauthenticated health check on GET /health", async () => {
    const res = await worker.fetch(
      new Request("https://proxy.example/health", { method: "GET" }),
      makeEnv(),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      service: string;
      providers: Record<string, boolean>;
    };
    expect(body.ok).toBe(true);
    expect(body.service).toBe("gn-tracing-oauth-proxy");
    expect(body.providers.google).toBe(true);
    expect(body.providers.dropbox).toBe(true);
    expect(body.providers).not.toHaveProperty("onedrive");
  });
});

describe("OAuth token proxy - configuration handling", () => {
  it("returns 500 when Google secret is missing on Google path", async () => {
    const res = await worker.fetch(
      makeTokenRequest("/token"),
      makeEnv({ GOOGLE_CLIENT_SECRET: "" }),
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("server_misconfigured");
  });

  it("returns 500 when Dropbox secret is missing on Dropbox path", async () => {
    const res = await worker.fetch(
      makeTokenRequest("/token/dropbox"),
      makeEnv({ DROPBOX_CLIENT_SECRET: "" }),
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe("server_misconfigured");
    expect(body.error_description).toMatch(/Dropbox/i);
  });

  it("rejects a disallowed origin with 403 before touching credentials", async () => {
    const res = await worker.fetch(
      makeTokenRequest("/token", { grant_type: "authorization_code" }, "https://evil.example"),
      makeEnv({ ALLOWED_EXTENSION_ORIGINS: "chrome-extension://only-this-one" }),
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("forbidden_origin");
  });

  it("returns 404 for unknown token paths including removed onedrive", async () => {
    const res = await worker.fetch(makeTokenRequest("/token/unknown"), makeEnv());
    expect(res.status).toBe(404);
    const od = await worker.fetch(makeTokenRequest("/token/onedrive"), makeEnv());
    expect(od.status).toBe(404);
  });
});

describe("OAuth token proxy - upstream relay", () => {
  it("relays Google token responses and injects Google credentials", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(url).toBe("https://oauth2.googleapis.com/token");
      const body = new URLSearchParams(String(init?.body ?? ""));
      expect(body.get("client_id")).toBe("placeholder-client-id.apps.googleusercontent.com");
      expect(body.get("client_secret")).toBe("placeholder-google-secret");
      expect(body.get("grant_type")).toBe("authorization_code");
      return new Response(JSON.stringify({ access_token: "g-atok", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      makeTokenRequest("/token", {
        grant_type: "authorization_code",
        code: "abc",
        code_verifier: "xyz",
        client_id: "evil-client",
        client_secret: "evil-secret",
      }),
      makeEnv(),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token: string };
    expect(body.access_token).toBe("g-atok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("relays Dropbox token responses to Dropbox token endpoint", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://api.dropboxapi.com/oauth2/token");
      return new Response(JSON.stringify({ access_token: "db-atok", token_type: "bearer" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      makeTokenRequest("/token/dropbox", {
        grant_type: "authorization_code",
        code: "db-code",
        code_verifier: "db-verifier",
        redirect_uri: "https://ext.chromiumapp.org/",
      }),
      makeEnv(),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token: string };
    expect(body.access_token).toBe("db-atok");
  });
});
