import { describe, expect, it } from "vitest";
import {
  parseProductVersion,
  pickProductVersion,
  productVersionOrDefault,
  requireProductVersion,
} from "./product-version";

describe("parseProductVersion", () => {
  it("accepts core semver", () => {
    expect(parseProductVersion("1.7.5")).toBe("1.7.5");
    expect(parseProductVersion(" 0.0.0 ")).toBe("0.0.0");
  });

  it("rejects invalid shapes", () => {
    expect(parseProductVersion(undefined)).toBeNull();
    expect(parseProductVersion("")).toBeNull();
    expect(parseProductVersion("v1.7.5")).toBeNull();
    expect(parseProductVersion("1.7")).toBeNull();
    expect(parseProductVersion("1.7.5-beta")).toBeNull();
  });
});

describe("pickProductVersion", () => {
  it("returns the first valid candidate", () => {
    expect(pickProductVersion(undefined, "", "1.6.3", "1.7.5")).toBe("1.6.3");
    expect(pickProductVersion("bad", "1.7.5")).toBe("1.7.5");
    expect(pickProductVersion(null, "nope")).toBeNull();
  });
});

describe("requireProductVersion", () => {
  it("returns valid versions", () => {
    expect(requireProductVersion("1.7.5", "extension")).toBe("1.7.5");
  });

  it("throws with surface label when invalid", () => {
    expect(() => requireProductVersion(undefined, "extension")).toThrow(/extension version/);
    expect(() => requireProductVersion("v1", "worker")).toThrow(/worker version/);
  });
});

describe("productVersionOrDefault", () => {
  it("falls back without throwing", () => {
    expect(productVersionOrDefault(undefined)).toBe("0.0.0");
    expect(productVersionOrDefault("1.2.3")).toBe("1.2.3");
  });
});
