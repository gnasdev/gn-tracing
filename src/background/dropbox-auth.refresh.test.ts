import { describe, expect, it } from "vitest";
import { isDropboxRefreshAuthDeath } from "./dropbox-auth";

describe("isDropboxRefreshAuthDeath", () => {
  it("treats 401 as fatal", () => {
    expect(isDropboxRefreshAuthDeath(401)).toBe(true);
    expect(isDropboxRefreshAuthDeath(401, "invalid_token")).toBe(true);
  });

  it("treats 400 invalid_grant (and related) as fatal", () => {
    expect(isDropboxRefreshAuthDeath(400, "invalid_grant")).toBe(true);
    expect(isDropboxRefreshAuthDeath(400, "invalid_token")).toBe(true);
    expect(isDropboxRefreshAuthDeath(400, "invalid_client")).toBe(true);
    expect(isDropboxRefreshAuthDeath(400, "unauthorized_client")).toBe(true);
    // Bare 400 without body often means dead refresh token from Dropbox.
    expect(isDropboxRefreshAuthDeath(400)).toBe(true);
  });

  it("keeps refresh token on rate limit and transient 4xx", () => {
    expect(isDropboxRefreshAuthDeath(429)).toBe(false);
    expect(isDropboxRefreshAuthDeath(429, "too_many_requests")).toBe(false);
    expect(isDropboxRefreshAuthDeath(408)).toBe(false);
    expect(isDropboxRefreshAuthDeath(403, "access_denied")).toBe(false);
  });

  it("keeps refresh token on 5xx", () => {
    expect(isDropboxRefreshAuthDeath(500)).toBe(false);
    expect(isDropboxRefreshAuthDeath(503)).toBe(false);
  });
});
