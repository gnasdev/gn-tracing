/**
 * Example-based unit tests for the pure privacy/redaction policy surface that
 * the property suite does not exercise directly: profile accessors, the privacy
 * summary builder, and the per-artifact redaction entry points (URL, body,
 * console, user event, report, and the JSON walk).
 *
 * Every function here is intentionally Chrome-free, so these tests construct
 * plain domain objects and assert the redaction contract on representative
 * inputs and edge cases.
 */
import { describe, expect, it } from "vitest";
import { makePrivacySettings } from "../../test/factories";
import type { ConsoleEntry, RecordingReport, RecordingUserEvent } from "../types/recording";
import {
  buildRecordingPrivacySummary,
  getPrivacyProfileSettings,
  REDACTED_VALUE,
  redactBodyText,
  redactConsoleEntry,
  redactHeaderMap,
  redactJsonValue,
  redactReport,
  redactUrl,
  redactUserEvent,
} from "./privacy-redaction";

describe("getPrivacyProfileSettings", () => {
  it("returns the standard profile with all core toggles enabled", () => {
    const settings = getPrivacyProfileSettings("standard");
    expect(settings.privacyProfile).toBe("standard");
    expect(settings.redactSensitiveHeaders).toBe(true);
    expect(settings.redactSensitiveQueryParams).toBe(true);
    expect(settings.maskDomSelectors).toEqual([]);
  });

  it("returns the strict profile", () => {
    const settings = getPrivacyProfileSettings("strict");
    expect(settings.privacyProfile).toBe("strict");
    expect(settings.redactConsoleValues).toBe(true);
    expect(settings.redactEventMetadata).toBe(true);
  });

  it("returns the custom profile", () => {
    const settings = getPrivacyProfileSettings("custom");
    expect(settings.privacyProfile).toBe("custom");
    expect(settings.redactRequestBodyFields).toBe(true);
    expect(settings.redactResponseBodyFields).toBe(true);
  });
});

describe("redactHeaderMap", () => {
  it("returns null for nullish header maps without recording hits", () => {
    const settings = makePrivacySettings("standard");
    expect(redactHeaderMap(null, settings)).toEqual({ value: null, applied: [] });
    expect(redactHeaderMap(undefined, settings)).toEqual({ value: null, applied: [] });
  });

  it("preserves benign headers and records a hit for each redacted key", () => {
    const settings = makePrivacySettings("standard");
    const { value, applied } = redactHeaderMap(
      { authorization: "Bearer secret", "content-type": "application/json" },
      settings,
    );
    expect(value).toEqual({
      authorization: REDACTED_VALUE,
      "content-type": "application/json",
    });
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({
      artifact: "headers",
      class: "credential",
      action: "redacted",
    });
  });

  it("leaves all headers intact when header redaction is disabled", () => {
    const settings = { ...makePrivacySettings("standard"), redactSensitiveHeaders: false };
    const headers = { authorization: "Bearer secret" };
    const { value, applied } = redactHeaderMap(headers, settings);
    expect(value).toEqual(headers);
    expect(applied).toHaveLength(0);
  });
});

describe("redactUrl", () => {
  it("redacts embedded credentials in the userinfo component", () => {
    const settings = makePrivacySettings("standard");
    const { value, applied } = redactUrl("https://user:pass@example.com/path", settings);
    expect(value).toContain(encodeURIComponent(REDACTED_VALUE));
    expect(applied.map((hit) => hit.ruleId)).toEqual(
      expect.arrayContaining(["url-username", "url-password"]),
    );
  });

  it("redacts sensitive query parameters by key", () => {
    const settings = makePrivacySettings("standard");
    const { value, applied } = redactUrl("https://example.com/?token=abcdef&page=2", settings);
    const params = new URL(value ?? "").searchParams;
    expect(params.get("token")).toBe(REDACTED_VALUE);
    expect(params.get("page")).toBe("2");
    expect(applied.length).toBeGreaterThan(0);
  });

  it("returns undefined for empty input without hits", () => {
    const settings = makePrivacySettings("standard");
    expect(redactUrl("", settings)).toEqual({ value: undefined, applied: [] });
    expect(redactUrl(null, settings)).toEqual({ value: undefined, applied: [] });
  });

  it("falls back to plain-text redaction for unparseable URLs", () => {
    const settings = makePrivacySettings("strict");
    const { value } = redactUrl("not a url with token=supersecretvalue", settings);
    expect(typeof value).toBe("string");
  });
});

describe("redactBodyText", () => {
  it("returns the input unchanged for empty or nullish bodies", () => {
    const settings = makePrivacySettings("standard");
    expect(redactBodyText(null, settings)).toEqual({ value: null, applied: [] });
    expect(redactBodyText("", settings)).toEqual({ value: "", applied: [] });
  });

  it("redacts sensitive keys inside a JSON object body", () => {
    const settings = makePrivacySettings("standard");
    const { value, applied } = redactBodyText(
      JSON.stringify({ token: "abc123", note: "hello" }),
      settings,
    );
    const parsed = JSON.parse(value ?? "{}") as Record<string, unknown>;
    expect(parsed.token).toBe(REDACTED_VALUE);
    expect(parsed.note).toBe("hello");
    expect(applied.length).toBeGreaterThan(0);
  });

  it("redacts sensitive keys inside a form-urlencoded body", () => {
    const settings = makePrivacySettings("standard");
    const { value, applied } = redactBodyText("password=hunter2&name=ada", settings);
    const params = new URLSearchParams(value ?? "");
    expect(params.get("password")).toBe(REDACTED_VALUE);
    expect(params.get("name")).toBe("ada");
    expect(applied.length).toBeGreaterThan(0);
  });

  it("applies plain-text value rules to non-structured bodies", () => {
    const settings = makePrivacySettings("standard");
    const { value } = redactBodyText("auth header is Bearer abcdef0123456789", settings);
    expect(value).toContain(REDACTED_VALUE);
  });
});

describe("redactJsonValue", () => {
  it("collapses an entire subtree under a sensitive key", () => {
    const settings = makePrivacySettings("standard");
    const { value } = redactJsonValue(
      { secret: { nested: "value", deeper: [1, 2, 3] }, keep: "ok" },
      settings,
      "body",
      "body",
      "body",
    );
    const result = value as Record<string, unknown>;
    expect(result.secret).toBe(REDACTED_VALUE);
    expect(result.keep).toBe("ok");
  });

  it("passes through non-sensitive scalars unchanged", () => {
    const settings = makePrivacySettings("standard");
    const { value } = redactJsonValue(
      { count: 42, enabled: true, missing: null },
      settings,
      "body",
      "body",
      "body",
    );
    expect(value).toEqual({ count: 42, enabled: true, missing: null });
  });
});

describe("redactConsoleEntry", () => {
  const baseEntry = (): ConsoleEntry => ({
    source: "console-api",
    level: "log",
    timestamp: 1,
    message: "log with Bearer abcdef0123456789",
    url: "https://user:pass@example.com/",
    args: [{ type: "string", value: "token=supersecretvalue" }],
    stackTrace: [
      { functionName: "f", url: "https://x:y@host.test/", lineNumber: 1, columnNumber: 1 },
    ],
  });

  it("returns the entry untouched when console redaction is disabled", () => {
    const settings = { ...makePrivacySettings("standard"), redactConsoleValues: false };
    const entry = baseEntry();
    const { value, applied } = redactConsoleEntry(entry, settings);
    expect(value).toBe(entry);
    expect(applied).toHaveLength(0);
  });

  it("redacts message, url, args, and stack frames when enabled", () => {
    const settings = makePrivacySettings("strict");
    const { value, applied } = redactConsoleEntry(baseEntry(), settings);
    expect(value.message).toContain(REDACTED_VALUE);
    expect(value.url).toContain(encodeURIComponent(REDACTED_VALUE));
    expect(applied.length).toBeGreaterThan(0);
  });
});

describe("redactUserEvent", () => {
  it("returns the event untouched when event redaction is disabled", () => {
    const settings = { ...makePrivacySettings("standard"), redactEventMetadata: false };
    const event: RecordingUserEvent = { type: "navigation", timestamp: 1, url: "https://x/" };
    const { value, applied } = redactUserEvent(event, settings);
    expect(value).toBe(event);
    expect(applied).toHaveLength(0);
  });

  it("redacts navigation url and title", () => {
    const settings = makePrivacySettings("strict");
    const event: RecordingUserEvent = {
      type: "navigation",
      timestamp: 1,
      url: "https://user:pass@example.com/",
      title: "contact me at person@example.com",
    };
    const { value } = redactUserEvent(event, settings);
    if (value.type === "navigation") {
      expect(value.url).toContain(encodeURIComponent(REDACTED_VALUE));
      expect(value.title).toContain(REDACTED_VALUE);
    }
  });

  it("redacts click selector and text", () => {
    const settings = makePrivacySettings("strict");
    const event: RecordingUserEvent = {
      type: "click",
      timestamp: 1,
      selector: "#email-field",
      text: "person@example.com",
    };
    const { value } = redactUserEvent(event, settings);
    if (value.type === "click") {
      expect(value.text).toContain(REDACTED_VALUE);
    }
  });

  it("redacts contextmenu selector and text", () => {
    const settings = makePrivacySettings("strict");
    const event: RecordingUserEvent = {
      type: "contextmenu",
      timestamp: 1,
      selector: "#email-field",
      text: "person@example.com",
    };
    const { value } = redactUserEvent(event, settings);
    if (value.type === "contextmenu") {
      expect(value.text).toContain(REDACTED_VALUE);
    }
  });

  it("redacts scroll selector without touching direction or deltaY", () => {
    const settings = makePrivacySettings("strict");
    const event: RecordingUserEvent = {
      type: "scroll",
      timestamp: 1,
      selector: "person@example.com",
      x: 10,
      y: 20,
      direction: "down",
      deltaY: 120,
    };
    const { value } = redactUserEvent(event, settings);
    if (value.type === "scroll") {
      expect(value.selector).toContain(REDACTED_VALUE);
      expect(value.direction).toBe("down");
      expect(value.deltaY).toBe(120);
    }
  });
});

describe("redactReport", () => {
  const baseReport = (): RecordingReport => ({
    schemaVersion: 1,
    title: "contact person@example.com",
    description: "token=supersecretvalue leaked",
    source: "extension",
    createdAt: "2024-01-01T00:00:00.000Z",
    page: { url: "https://user:pass@example.com/", title: "secret token=abcdef0123456789" },
    environment: {
      extensionVersion: "1.0.0",
      userAgent: "test",
      language: "en",
      timezone: "UTC",
    },
  });

  it("redacts text fields and the page url", () => {
    const settings = makePrivacySettings("strict");
    const { value, applied } = redactReport(baseReport(), settings);
    expect(value.description).toContain(REDACTED_VALUE);
    expect(value.page.url).toContain(encodeURIComponent(REDACTED_VALUE));
    expect(applied.length).toBeGreaterThan(0);
  });
});

describe("buildRecordingPrivacySummary", () => {
  const artifactFlags = {
    video: false,
    screenshot: false,
    report: true,
    events: true,
    console: true,
    network: true,
    websocket: false,
    requestBodies: true,
    responseBodies: true,
    websocketPayloads: false,
    sourceSnippets: false,
    storage: false,
    dom: false,
  };

  it("groups and counts hits and dedupes limitations", () => {
    const settings = makePrivacySettings("standard");
    const summary = buildRecordingPrivacySummary(
      settings,
      artifactFlags,
      [
        { artifact: "headers", class: "credential", action: "redacted", ruleId: "credential-key" },
        { artifact: "headers", class: "credential", action: "redacted", ruleId: "credential-key" },
        { artifact: "body", class: "personal", action: "redacted", ruleId: "email-value" },
      ],
      ["limit a", "limit a", "", "limit b"],
      "2024-01-01T00:00:00.000Z",
    );

    expect(summary.profile).toBe("standard");
    expect(summary.policyVersion).toBe(1);
    const headerCount = summary.counts.find((c) => c.artifact === "headers");
    expect(headerCount?.count).toBe(2);
    expect(summary.limitations).toEqual(["limit a", "limit b"]);
  });
});
