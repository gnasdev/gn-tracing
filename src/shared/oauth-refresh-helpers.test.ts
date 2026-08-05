import { afterEach, describe, expect, it, vi } from "vitest";
import { isDropboxRefreshAuthDeath } from "../background/dropbox-auth";
import {
  computeAccessTokenExpiresAt,
  fetchOAuthTokenResponse,
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
