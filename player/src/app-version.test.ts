import { describe, expect, it } from "vitest";
import { getProductVersion, getProductVersionOrDefault } from "./app-version";

describe("player getProductVersion", () => {
  it("reads VITE_APP_VERSION baked from root package.json", () => {
    expect(getProductVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("soft default matches hard read when defined", () => {
    expect(getProductVersionOrDefault()).toBe(getProductVersion());
  });
});
