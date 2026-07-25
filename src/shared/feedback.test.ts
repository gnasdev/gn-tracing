/**
 * Unit tests for opt-in feedback helpers.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildFeedbackDiagnostics,
  buildFeedbackIssueTitle,
  FEEDBACK_MESSAGE_MAX_LENGTH,
  formatFeedbackIssueBody,
  normalizeFeedbackDiagnostics,
  parseBrowserFromUserAgent,
  parseOsFromUserAgent,
  validateFeedbackMessage,
} from "./feedback";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseOsFromUserAgent", () => {
  it("detects common desktop and mobile OS labels", () => {
    expect(parseOsFromUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("macOS");
    expect(parseOsFromUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("Windows");
    expect(parseOsFromUserAgent("Mozilla/5.0 (X11; Linux x86_64)")).toBe("Linux");
    expect(parseOsFromUserAgent("Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)")).toBe("Chrome OS");
    expect(parseOsFromUserAgent("Mozilla/5.0 (Linux; Android 14)")).toBe("Android");
    expect(parseOsFromUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBe(
      "iOS",
    );
    expect(parseOsFromUserAgent("")).toBe("Unknown");
  });
});

describe("parseBrowserFromUserAgent", () => {
  it("prefers Edge over Chrome when both tokens appear", () => {
    const result = parseBrowserFromUserAgent(
      "Mozilla/5.0 Chrome/131.0.0.0 Edg/131.0.0.0 Safari/537.36",
    );
    expect(result).toEqual({ browserName: "Edge", browserVersion: "131.0.0.0" });
  });
});

describe("validateFeedbackMessage", () => {
  it("rejects empty or non-string input", () => {
    expect(validateFeedbackMessage("")).toEqual({
      ok: false,
      error: "Feedback message is required.",
    });
    expect(validateFeedbackMessage("   ")).toEqual({
      ok: false,
      error: "Feedback message is required.",
    });
    expect(validateFeedbackMessage(null).ok).toBe(false);
  });

  it("trims valid messages and enforces max length", () => {
    expect(validateFeedbackMessage("  hello  ")).toEqual({ ok: true, message: "hello" });
    const tooLong = "x".repeat(FEEDBACK_MESSAGE_MAX_LENGTH + 1);
    expect(validateFeedbackMessage(tooLong).ok).toBe(false);
  });
});

describe("normalizeFeedbackDiagnostics", () => {
  it("allow-lists fields and drops unknown keys", () => {
    const result = normalizeFeedbackDiagnostics({
      extensionVersion: "1.2.3",
      browserName: "Chrome",
      browserVersion: "120",
      os: "macOS",
      locale: "en-US",
      token: "secret",
      tabUrl: "https://evil.example",
    });
    expect(result).toEqual({
      extensionVersion: "1.2.3",
      browserName: "Chrome",
      browserVersion: "120",
      os: "macOS",
      locale: "en-US",
    });
    expect(result).not.toHaveProperty("token");
    expect(result).not.toHaveProperty("tabUrl");
  });

  it("defaults missing version to unknown", () => {
    expect(normalizeFeedbackDiagnostics(undefined).extensionVersion).toBe("unknown");
  });
});

describe("buildFeedbackIssueTitle / formatFeedbackIssueBody", () => {
  it("builds a short title and fenced body", () => {
    const title = buildFeedbackIssueTitle("Line one\nLine two with more text that is quite long");
    expect(title.startsWith("Feedback: ")).toBe(true);
    expect(title.length).toBeLessThanOrEqual("Feedback: ".length + 61);

    const body = formatFeedbackIssueBody("please fix ``` injection", {
      extensionVersion: "1.0.0",
      browserName: "Chrome",
      browserVersion: "131",
      os: "macOS",
      locale: "en-US",
    });
    expect(body).toContain("## Feedback");
    expect(body).toContain("## Diagnostics");
    expect(body).toContain("please fix ''' injection");
    expect(body).toContain("Extension: 1.0.0");
    expect(body).toContain("Browser: Chrome 131");
  });
});

describe("buildFeedbackDiagnostics", () => {
  it("reads version, browser, OS, and locale from the environment", () => {
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
      language: "vi-VN",
    });
    vi.stubGlobal("chrome", {
      runtime: {
        getManifest: () => ({ version: "9.9.9" }),
      },
    });

    expect(buildFeedbackDiagnostics()).toEqual({
      extensionVersion: "9.9.9",
      browserName: "Chrome",
      browserVersion: "131.0.0.0",
      os: "macOS",
      locale: "vi-VN",
    });
  });
});
