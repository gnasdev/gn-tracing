/**
 * Integration tests for the multi-issuer OAuth token-exchange Worker handler.
 *
 * SECURITY: every env binding is a synthetic placeholder. Upstream provider
 * calls are intercepted via stubbed global `fetch` — no real network.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import worker, {
  buildFeedbackIssueTitle,
  type Env,
  formatFeedbackIssueBody,
  isFeedbackOriginAllowed,
  isFeedbackPath,
  resolveProviderFromPath,
} from "./index";

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

function makeFeedbackRequest(
  body: Record<string, unknown>,
  origin: string | null = PLACEHOLDER_ORIGIN,
): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (origin) {
    headers.Origin = origin;
  }
  return new Request("https://proxy.example/feedback", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function makeTokenRequest(
  path: string,
  body: Record<string, string> = {
    grant_type: "authorization_code",
    code: "abc",
    code_verifier: "xyz",
    // Platform extension redirect only (Google OAuth domain ownership policy).
    redirect_uri: "https://abcdefghijklmnopqrstuvwxyzabcdef.chromiumapp.org/",
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
    expect(resolveProviderFromPath("/feedback")).toBeNull();
  });
});

describe("isFeedbackPath", () => {
  it("matches /feedback only", () => {
    expect(isFeedbackPath("/feedback")).toBe(true);
    expect(isFeedbackPath("/feedback/")).toBe(true);
    expect(isFeedbackPath("/token")).toBe(false);
  });
});

describe("isFeedbackOriginAllowed", () => {
  it("allows chrome-extension origins and default player web origins", () => {
    const env = makeEnv();
    expect(isFeedbackOriginAllowed(PLACEHOLDER_ORIGIN, env)).toBe(true);
    expect(isFeedbackOriginAllowed("https://tracing.gnas.dev", env)).toBe(true);
    expect(isFeedbackOriginAllowed("http://localhost:5176", env)).toBe(true);
    expect(isFeedbackOriginAllowed("https://evil.example", env)).toBe(false);
  });

  it("respects ALLOWED_WEB_ORIGINS override for feedback", () => {
    const env = makeEnv({ ALLOWED_WEB_ORIGINS: "https://custom.player.test" });
    expect(isFeedbackOriginAllowed("https://custom.player.test", env)).toBe(true);
    expect(isFeedbackOriginAllowed("https://tracing.gnas.dev", env)).toBe(false);
  });
});

describe("feedback issue formatting", () => {
  it("builds title and body with diagnostics", () => {
    expect(buildFeedbackIssueTitle("hello\nworld")).toBe("Feedback: hello world");
    const body = formatFeedbackIssueBody("note", {
      extensionVersion: "1.0.0",
      browserName: "Chrome",
      browserVersion: "131",
      os: "macOS",
      locale: "en-US",
    });
    expect(body).toContain("Extension: 1.0.0");
    expect(body).toContain("Browser: Chrome 131");
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
      version?: string;
      requestRouteVersion?: string | null;
      providers: Record<string, boolean>;
    };
    expect(body.ok).toBe(true);
    expect(body.service).toBe("gn-tracing-oauth-proxy");
    expect(typeof body.version).toBe("string");
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(body.requestRouteVersion).toBeNull();
    expect(body.providers.google).toBe(true);
    expect(body.providers.dropbox).toBe(true);
    expect(body.providers).not.toHaveProperty("onedrive");
    expect((body as { feedback?: boolean }).feedback).toBe(false);
  });

  it("serves versioned health and oauth paths for any product version prefix", async () => {
    const health = await worker.fetch(
      new Request("https://proxy.example/1.6.3/health", { method: "GET" }),
      makeEnv(),
    );
    expect(health.status).toBe(200);
    const healthBody = (await health.json()) as {
      ok: boolean;
      requestRouteVersion: string | null;
    };
    expect(healthBody.ok).toBe(true);
    expect(healthBody.requestRouteVersion).toBe("1.6.3");

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.github.com")) {
        return new Response(
          JSON.stringify({
            html_url: "https://github.com/gnasdev/gn-tracing/issues/99",
            number: 99,
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const token = await worker.fetch(
      makeTokenRequest("/1.7.5/token"),
      makeEnv({ ALLOWED_EXTENSION_ORIGINS: PLACEHOLDER_ORIGIN }),
    );
    expect(token.status).toBe(200);

    const dropbox = await worker.fetch(
      makeTokenRequest("/1.0.0/token/dropbox"),
      makeEnv({ ALLOWED_EXTENSION_ORIGINS: PLACEHOLDER_ORIGIN }),
    );
    expect(dropbox.status).toBe(200);

    const feedback = await worker.fetch(
      new Request("https://proxy.example/1.7.5/feedback", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: PLACEHOLDER_ORIGIN,
        },
        body: JSON.stringify({ message: "versioned path works fine here" }),
      }),
      makeEnv({ GITHUB_FEEDBACK_TOKEN: "ghs_placeholder" }),
    );
    expect([200, 201]).toContain(feedback.status);
  });
});

describe("Feedback proxy", () => {
  it("rejects forbidden origins", async () => {
    const res = await worker.fetch(
      makeFeedbackRequest({ message: "hi" }, "https://evil.example"),
      makeEnv({
        ALLOWED_EXTENSION_ORIGINS: "chrome-extension://only-this-one",
        GITHUB_FEEDBACK_TOKEN: "ghs_placeholder",
      }),
    );
    expect(res.status).toBe(403);
  });

  it("returns 503 when token is missing", async () => {
    const res = await worker.fetch(makeFeedbackRequest({ message: "hi" }), makeEnv());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("server_misconfigured");
  });

  it("returns 400 for empty message", async () => {
    const res = await worker.fetch(
      makeFeedbackRequest({ message: "  " }),
      makeEnv({ GITHUB_FEEDBACK_TOKEN: "ghs_placeholder" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
  });

  it("creates a GitHub issue on success", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.github.com/repos/gnasdev/gn-tracing/issues");
      expect(init?.method).toBe("POST");
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer ghs_placeholder");
      const payload = JSON.parse(String(init?.body ?? "{}")) as {
        title: string;
        body: string;
        labels?: string[];
      };
      expect(payload.title.startsWith("Feedback: ")).toBe(true);
      expect(payload.body).toContain("please improve");
      expect(payload.body).toContain("Extension: 1.2.3");
      expect(payload.labels).toEqual(["feedback"]);
      return new Response(
        JSON.stringify({
          html_url: "https://github.com/gnasdev/gn-tracing/issues/42",
          number: 42,
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      makeFeedbackRequest({
        message: "please improve",
        diagnostics: {
          extensionVersion: "1.2.3",
          browserName: "Chrome",
          browserVersion: "131",
          os: "macOS",
          locale: "en-US",
          token: "must-be-ignored",
        },
      }),
      makeEnv({ GITHUB_FEEDBACK_TOKEN: "ghs_placeholder" }),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; issueUrl: string; issueNumber: number };
    expect(body.ok).toBe(true);
    expect(body.issueUrl).toBe("https://github.com/gnasdev/gn-tracing/issues/42");
    expect(body.issueNumber).toBe(42);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts feedback from the hosted player web origin", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              html_url: "https://github.com/gnasdev/gn-tracing/issues/9",
              number: 9,
            }),
            {
              status: 201,
              headers: { "Content-Type": "application/json" },
            },
          ),
      ),
    );

    const res = await worker.fetch(
      makeFeedbackRequest({ message: "from player" }, "https://tracing.gnas.dev"),
      makeEnv({ GITHUB_FEEDBACK_TOKEN: "ghs_placeholder" }),
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://tracing.gnas.dev");
  });

  it("rejects OAuth token exchange from web player origin", async () => {
    const res = await worker.fetch(
      makeTokenRequest("/token", undefined, "https://tracing.gnas.dev"),
      makeEnv(),
    );
    expect(res.status).toBe(403);
  });

  it("retries without labels when GitHub rejects labels", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      const payload = JSON.parse(String(init?.body ?? "{}")) as { labels?: string[] };
      if (calls === 1) {
        expect(payload.labels).toEqual(["feedback"]);
        return new Response(JSON.stringify({ message: "Label does not exist" }), {
          status: 422,
          headers: { "Content-Type": "application/json" },
        });
      }
      expect(payload.labels).toBeUndefined();
      return new Response(
        JSON.stringify({
          html_url: "https://github.com/gnasdev/gn-tracing/issues/7",
          number: 7,
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      makeFeedbackRequest({ message: "label missing ok" }),
      makeEnv({ GITHUB_FEEDBACK_TOKEN: "ghs_placeholder" }),
    );
    expect(res.status).toBe(201);
    expect(calls).toBe(2);
  });
});

describe("OAuth token proxy - STRICT_ORIGIN", () => {
  it("returns 500 when STRICT_ORIGIN is on and allow-list is empty", async () => {
    const res = await worker.fetch(
      makeTokenRequest("/token"),
      makeEnv({ STRICT_ORIGIN: "true", ALLOWED_EXTENSION_ORIGINS: "" }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("server_misconfigured");
  });

  it("still allows listed origins when STRICT_ORIGIN is on", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ access_token: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      makeTokenRequest("/token"),
      makeEnv({
        STRICT_ORIGIN: "true",
        ALLOWED_EXTENSION_ORIGINS: PLACEHOLDER_ORIGIN,
      }),
    );
    expect(res.status).toBe(200);
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
        redirect_uri: "https://abcdefghijklmnopqrstuvwxyzabcdef.chromiumapp.org/",
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

  it("rejects authorization_code with a non-extension redirect_uri", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await worker.fetch(
      makeTokenRequest("/token", {
        grant_type: "authorization_code",
        code: "abc",
        code_verifier: "xyz",
        redirect_uri: "https://tracing.gnas.dev/oauth/callback",
      }),
      makeEnv(),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe("invalid_request");
    expect(body.error_description).toMatch(/platform extension domain/i);
    expect(fetchMock).not.toHaveBeenCalled();
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
        redirect_uri: "https://abcdefghijklmnopqrstuvwxyzabcdef.chromiumapp.org/",
      }),
      makeEnv(),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token: string };
    expect(body.access_token).toBe("db-atok");
  });
});
