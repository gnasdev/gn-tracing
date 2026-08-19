import { afterEach, describe, expect, it, vi } from "vitest";
import { isDropboxRefreshAuthDeath } from "../background/dropbox-auth";
import {
  computeAccessTokenExpiresAt,
  fetchOAuthTokenResponse,
  formatOAuthTokenExchangeNetworkError,
  isOAuthRefreshAuthDeath,
  OAUTH_TOKEN_EXPIRY_BUFFER_MS,
} from "./oauth-pkce";

describe("isOAuthRefreshAuthDeath", () => {
  it("matches Dropbox wrapper behavior", () => {
    for (const status of [401, 400]) {
      expect(isOAuthRefreshAuthDeath(status)).toBe(isDropboxRefreshAuthDeath(status));
    }
    expect(isOAuthRefreshAuthDeath(400, "invalid_grant")).toBe(true);
    expect(isOAuthRefreshAuthDeath(429)).toBe(false);
    expect(isDropboxRefreshAuthDeath(429)).toBe(false);
  });
});

describe("computeAccessTokenExpiresAt", () => {
  it("applies the shared buffer", () => {
    const now = 1_000_000;
    expect(computeAccessTokenExpiresAt(3600, now)).toBe(
      now + 3600 * 1000 - OAUTH_TOKEN_EXPIRY_BUFFER_MS,
    );
  });
});

describe("formatOAuthTokenExchangeNetworkError", () => {
  it("gives local Worker guidance for loopback endpoints", () => {
    for (const endpoint of [
      "http://localhost:63972/1.7.11/token",
      "https://127.0.0.1:63972/token",
      "http://[::1]:63972/token",
    ]) {
      const error = formatOAuthTokenExchangeNetworkError("Failed to fetch", endpoint);
      expect(error).toContain("could not be reached");
      expect(error).toContain("task worker:dev");
    }
  });

  it("keeps generic host permission guidance for remote endpoints", () => {
    const error = formatOAuthTokenExchangeNetworkError(
      "Failed to fetch",
      "https://oauth.example.test/token",
    );
    expect(error).toContain("host_permissions");
    expect(error).not.toContain("task worker:dev");
  });
});

describe("fetchOAuthTokenResponse", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts form body with timeout abort support", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(init?.body).toBeInstanceOf(URLSearchParams);
      expect(init?.signal).toBeDefined();
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const body = new URLSearchParams({ grant_type: "refresh_token" });
    const response = await fetchOAuthTokenResponse({
      url: "https://example.com/token",
      body,
      timeoutMs: 5000,
    });
    expect(response.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://example.com/token");
  });
});
