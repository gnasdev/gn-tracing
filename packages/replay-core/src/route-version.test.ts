import { describe, expect, it } from "vitest";
import {
  isProductRouteVersion,
  joinVersionedPath,
  pickWorkerOrigin,
  resolveVersionedWorkerEndpoints,
  stripRouteVersionPrefix,
} from "./route-version";

describe("isProductRouteVersion", () => {
  it("accepts core semver only", () => {
    expect(isProductRouteVersion("1.7.5")).toBe(true);
    expect(isProductRouteVersion("0.0.0")).toBe(true);
    expect(isProductRouteVersion("10.20.30")).toBe(true);
    expect(isProductRouteVersion("1.7")).toBe(false);
    expect(isProductRouteVersion("v1.7.5")).toBe(false);
    expect(isProductRouteVersion("1.7.5-beta")).toBe(false);
    expect(isProductRouteVersion("gdrive")).toBe(false);
  });
});

describe("stripRouteVersionPrefix", () => {
  it("leaves legacy paths unchanged", () => {
    expect(stripRouteVersionPrefix("/token")).toEqual({
      routeVersion: null,
      remainder: "/token",
    });
    expect(stripRouteVersionPrefix("/token/dropbox")).toEqual({
      routeVersion: null,
      remainder: "/token/dropbox",
    });
    expect(stripRouteVersionPrefix("/gdrive/abc")).toEqual({
      routeVersion: null,
      remainder: "/gdrive/abc",
    });
    expect(stripRouteVersionPrefix("/")).toEqual({ routeVersion: null, remainder: "/" });
  });

  it("strips a leading product version segment", () => {
    expect(stripRouteVersionPrefix("/1.7.5/token")).toEqual({
      routeVersion: "1.7.5",
      remainder: "/token",
    });
    expect(stripRouteVersionPrefix("/1.6.3/token/dropbox")).toEqual({
      routeVersion: "1.6.3",
      remainder: "/token/dropbox",
    });
    expect(stripRouteVersionPrefix("/1.7.5/gdrive/fileId")).toEqual({
      routeVersion: "1.7.5",
      remainder: "/gdrive/fileId",
    });
    expect(stripRouteVersionPrefix("/1.7.5")).toEqual({
      routeVersion: "1.7.5",
      remainder: "/",
    });
  });

  it("does not treat Drive bare ids as versions", () => {
    expect(stripRouteVersionPrefix("/1AbCdEfGhIjKlMnOp")).toEqual({
      routeVersion: null,
      remainder: "/1AbCdEfGhIjKlMnOp",
    });
  });
});

describe("joinVersionedPath", () => {
  it("joins version and remainder", () => {
    expect(joinVersionedPath("1.7.5", "/token")).toBe("/1.7.5/token");
    expect(joinVersionedPath("1.7.5", "/")).toBe("/1.7.5");
    expect(joinVersionedPath("1.7.5", "token/dropbox")).toBe("/1.7.5/token/dropbox");
    expect(joinVersionedPath("1.7.5", "/gdrive/abc")).toBe("/1.7.5/gdrive/abc");
  });

  it("rejects invalid versions", () => {
    expect(() => joinVersionedPath("v1", "/token")).toThrow(/Invalid product route version/);
  });
});

describe("resolveVersionedWorkerEndpoints", () => {
  it("joins origin with versioned paths", () => {
    const endpoints = resolveVersionedWorkerEndpoints(
      "https://gn-tracing-oauth-proxy.example.workers.dev",
      "1.7.5",
    );
    expect(endpoints.origin).toBe("https://gn-tracing-oauth-proxy.example.workers.dev");
    expect(endpoints.googleTokenUrl).toBe(
      "https://gn-tracing-oauth-proxy.example.workers.dev/1.7.5/token",
    );
    expect(endpoints.dropboxTokenUrl).toBe(
      "https://gn-tracing-oauth-proxy.example.workers.dev/1.7.5/token/dropbox",
    );
    expect(endpoints.feedbackUrl).toBe(
      "https://gn-tracing-oauth-proxy.example.workers.dev/1.7.5/feedback",
    );
    expect(endpoints.healthUrl).toBe(
      "https://gn-tracing-oauth-proxy.example.workers.dev/1.7.5/health",
    );
  });

  it("re-bases legacy full token URLs onto the product version", () => {
    const endpoints = resolveVersionedWorkerEndpoints(
      "https://proxy.example/token/dropbox",
      "1.7.5",
    );
    expect(endpoints.dropboxTokenUrl).toBe("https://proxy.example/1.7.5/token/dropbox");
    expect(endpoints.googleTokenUrl).toBe("https://proxy.example/1.7.5/token");
  });

  it("returns empty endpoints when unset", () => {
    expect(resolveVersionedWorkerEndpoints("", "1.7.5").googleTokenUrl).toBe("");
  });
});

describe("pickWorkerOrigin", () => {
  it("returns the first parseable origin", () => {
    expect(pickWorkerOrigin("", "https://proxy.example/token", "https://other.example")).toBe(
      "https://proxy.example",
    );
    expect(pickWorkerOrigin()).toBe("");
  });
});
