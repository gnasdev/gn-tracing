import { describe, expect, it } from "vitest";
import {
  hostnameFromTabUrl,
  hostnameMatchesDomainPattern,
  hostnameMatchesInstantReplayAllowlist,
  normalizeInstantReplayAllowedDomains,
  normalizeInstantReplayDomainPattern,
  tabUrlMatchesInstantReplayAllowlist,
} from "./instant-replay-domain";

describe("normalizeInstantReplayDomainPattern", () => {
  it("normalizes URLs and hosts", () => {
    expect(normalizeInstantReplayDomainPattern("https://App.Example.com/path")).toBe(
      "app.example.com",
    );
    expect(normalizeInstantReplayDomainPattern("*.Example.COM")).toBe("*.example.com");
    expect(normalizeInstantReplayDomainPattern("localhost:3000")).toBe("localhost");
  });

  it("rejects junk", () => {
    expect(normalizeInstantReplayDomainPattern("")).toBeNull();
    expect(normalizeInstantReplayDomainPattern("*")).toBeNull();
    expect(normalizeInstantReplayDomainPattern("not a host")).toBeNull();
  });
});

describe("hostnameMatchesDomainPattern", () => {
  it("matches exact and wildcard", () => {
    expect(hostnameMatchesDomainPattern("app.example.com", "app.example.com")).toBe(true);
    expect(hostnameMatchesDomainPattern("app.example.com", "*.example.com")).toBe(true);
    expect(hostnameMatchesDomainPattern("example.com", "*.example.com")).toBe(true);
    expect(hostnameMatchesDomainPattern("evil-example.com", "*.example.com")).toBe(false);
    expect(hostnameMatchesDomainPattern("example.com.evil.com", "*.example.com")).toBe(false);
  });
});

describe("allowlist matching", () => {
  it("matches nothing when empty", () => {
    expect(hostnameMatchesInstantReplayAllowlist("app.example.com", [])).toBe(false);
    expect(tabUrlMatchesInstantReplayAllowlist("https://app.example.com/", [])).toBe(false);
  });

  it("matches tab URLs against the list", () => {
    const list = normalizeInstantReplayAllowedDomains(["https://app.example.com", "*.other.test"]);
    expect(list).toEqual(["app.example.com", "*.other.test"]);
    expect(tabUrlMatchesInstantReplayAllowlist("https://app.example.com/x", list)).toBe(true);
    expect(tabUrlMatchesInstantReplayAllowlist("https://a.other.test/", list)).toBe(true);
    expect(tabUrlMatchesInstantReplayAllowlist("https://nope.com/", list)).toBe(false);
    expect(hostnameFromTabUrl("chrome://extensions")).toBeNull();
  });
});
