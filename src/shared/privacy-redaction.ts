/**
 * Shared privacy policy and redaction helpers for capture artifacts.
 *
 * Keep this module independent from Chrome APIs so the service worker, content
 * script, settings page, and future tests can use the same policy version.
 */
import type { PrivacyProfile, PrivacyRedactionSettings } from "../types/messages";
import type {
  ConsoleEntry,
  RecordingPrivacySummary,
  RecordingReport,
  RecordingUserEvent,
  RedactionArtifact,
  RedactionClass,
  RedactionHit,
  SerializedRemoteObject,
  SourceCodeSnippet,
  StackFrame,
} from "../types/recording";

const REDACTION_POLICY_VERSION = 1;
export const REDACTED_VALUE = "[redacted by GN Tracing]";

export interface RedactionResult<T> {
  value: T;
  applied: RedactionHit[];
}

export type RuleTarget = "header" | "query" | "body" | "console" | "websocket" | "event" | "report";

interface ClassifiedRule {
  id: string;
  class: RedactionClass;
  pattern: RegExp;
  profiles: PrivacyProfile[];
  targets: RuleTarget[];
}

const STANDARD_PROFILES: PrivacyProfile[] = ["standard", "strict", "custom"];
const STRICT_PROFILES: PrivacyProfile[] = ["strict"];

const KEY_RULES: ClassifiedRule[] = [
  {
    id: "credential-key",
    class: "credential",
    pattern:
      /(password|passwd|pwd|token|access[_-]?token|refresh[_-]?token|id[_-]?token|secret|api[-_]?key|apikey|authorization|auth[_-]?code|credential|session|cookie|csrf|xsrf|jwt)/i,
    profiles: STANDARD_PROFILES,
    targets: ["header", "query", "body", "console", "websocket", "event", "report"],
  },
  {
    id: "payment-key",
    class: "payment",
    pattern: /(card|credit|cvv|cvc|expiry|exp[_-]?date|billing)/i,
    profiles: STANDARD_PROFILES,
    targets: ["body", "console", "websocket", "event", "report"],
  },
  {
    id: "personal-key",
    class: "personal",
    pattern:
      /(email|phone|mobile|full[_-]?name|first[_-]?name|last[_-]?name|user[_-]?name|customer[_-]?id|account[_-]?id)/i,
    profiles: STRICT_PROFILES,
    targets: ["query", "body", "console", "websocket", "event", "report"],
  },
  {
    id: "location-key",
    class: "location",
    pattern: /(address|street|city|postal|zipcode|zip[_-]?code|latitude|longitude|lat|lng)/i,
    profiles: STRICT_PROFILES,
    targets: ["body", "console", "websocket", "event", "report"],
  },
];

const VALUE_RULES: ClassifiedRule[] = [
  {
    id: "bearer-token-value",
    class: "credential",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
    profiles: STANDARD_PROFILES,
    targets: ["body", "console", "websocket", "event", "report"],
  },
  {
    id: "jwt-value",
    class: "credential",
    pattern: /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/g,
    profiles: STANDARD_PROFILES,
    targets: ["query", "body", "console", "websocket", "event", "report"],
  },
  {
    id: "credential-assignment-value",
    class: "credential",
    pattern:
      /\b(password|passwd|pwd|token|secret|api[-_]?key|authorization)\b(["'\s:=]+)([^"'\s,&}]{4,})/gi,
    profiles: STANDARD_PROFILES,
    targets: ["body", "console", "websocket", "event", "report"],
  },
  {
    id: "email-value",
    class: "personal",
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    profiles: STRICT_PROFILES,
    targets: ["query", "body", "console", "websocket", "event", "report"],
  },
  {
    id: "uuid-value",
    class: "opaque-id",
    pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
    profiles: STRICT_PROFILES,
    targets: ["query", "body", "console", "websocket", "event", "report"],
  },
  {
    id: "long-opaque-value",
    class: "opaque-id",
    pattern: /\b[A-Za-z0-9_-]{32,}\b/g,
    profiles: STRICT_PROFILES,
    targets: ["query", "body", "console", "websocket"],
  },
];

/**
 * Every redaction rule target. Exposed so callers (and tests) can enumerate the
 * targets a rule may apply to without duplicating the union literal.
 */
export const REDACTION_RULE_TARGETS: RuleTarget[] = [
  "header",
  "query",
  "body",
  "console",
  "websocket",
  "event",
  "report",
];

/**
 * Returns the set of redaction rule ids enabled for a given privacy profile and
 * target. Behavior-preserving introspection helper used to assert policy
 * invariants (e.g. profile monotonicity) without exposing the internal rule
 * tables. Combines both key-based and value-based rules.
 */
export function getEnabledRedactionRuleIds(
  profile: PrivacyProfile,
  target: RuleTarget,
): Set<string> {
  const ids = new Set<string>();
  for (const rule of [...KEY_RULES, ...VALUE_RULES]) {
    if (isRuleEnabled(rule, profile, target)) {
      ids.add(rule.id);
    }
  }
  return ids;
}

export function getPrivacyProfileSettings(profile: PrivacyProfile): PrivacyRedactionSettings {
  if (profile === "strict") {
    return {
      privacyProfile: "strict",
      redactSensitiveHeaders: true,
      redactSensitiveQueryParams: true,
      redactRequestBodyFields: true,
      redactResponseBodyFields: true,
      redactConsoleValues: true,
      redactWebSocketPayloads: "sensitive-fields",
      redactEventMetadata: true,
      maskDomSelectors: [],
    };
  }

  if (profile === "custom") {
    return {
      privacyProfile: "custom",
      redactSensitiveHeaders: true,
      redactSensitiveQueryParams: true,
      redactRequestBodyFields: true,
      redactResponseBodyFields: true,
      redactConsoleValues: true,
      redactWebSocketPayloads: "sensitive-fields",
      redactEventMetadata: true,
      maskDomSelectors: [],
    };
  }

  return {
    privacyProfile: "standard",
    redactSensitiveHeaders: true,
    redactSensitiveQueryParams: true,
    redactRequestBodyFields: true,
    redactResponseBodyFields: true,
    redactConsoleValues: true,
    redactWebSocketPayloads: "sensitive-fields",
    redactEventMetadata: true,
    maskDomSelectors: [],
  };
}

export function normalizeMaskDomSelectors(value: unknown): string[] {
  const rawItems = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\r?\n|,/)
      : [];

  const selectors: string[] = [];
  for (const item of rawItems) {
    if (typeof item !== "string") {
      continue;
    }
    const selector = item.trim();
    if (!selector || selector.length > 180 || selectors.includes(selector)) {
      continue;
    }
    selectors.push(selector);
    if (selectors.length >= 50) {
      break;
    }
  }
  return selectors;
}

function summarizeRedactionHits(hits: RedactionHit[]): RecordingPrivacySummary["counts"] {
  const grouped = new Map<string, RecordingPrivacySummary["counts"][number]>();
  for (const hit of hits) {
    const key = `${hit.artifact}:${hit.class}:${hit.action}`;
    const current = grouped.get(key);
    if (current) {
      current.count += 1;
    } else {
      grouped.set(key, {
        artifact: hit.artifact,
        class: hit.class,
        action: hit.action,
        count: 1,
      });
    }
  }
  return Array.from(grouped.values()).sort(
    (left, right) =>
      left.artifact.localeCompare(right.artifact) ||
      left.class.localeCompare(right.class) ||
      left.action.localeCompare(right.action),
  );
}

export function buildRecordingPrivacySummary(
  settings: PrivacyRedactionSettings,
  artifactFlags: RecordingPrivacySummary["artifactFlags"],
  hits: RedactionHit[],
  limitations: string[],
  createdAt: string,
): RecordingPrivacySummary {
  return {
    schemaVersion: 1,
    policyVersion: REDACTION_POLICY_VERSION,
    profile: settings.privacyProfile,
    createdAt,
    artifactFlags,
    counts: summarizeRedactionHits(hits),
    limitations: Array.from(new Set(limitations.filter(Boolean))).slice(0, 24),
  };
}

export function redactHeaderMap(
  headers: Record<string, string> | null | undefined,
  settings: PrivacyRedactionSettings,
  artifact: RedactionArtifact = "headers",
): RedactionResult<Record<string, string> | null> {
  if (!headers) {
    return { value: null, applied: [] };
  }

  const applied: RedactionHit[] = [];
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const classified = settings.redactSensitiveHeaders
      ? classifyKey(name, "header", settings.privacyProfile)
      : null;
    if (classified) {
      result[name] = REDACTED_VALUE;
      applied.push(
        hit(
          artifact,
          classified.class,
          "redacted",
          `headers.${sanitizeField(name)}`,
          classified.id,
        ),
      );
    } else {
      result[name] = value;
    }
  }
  return { value: result, applied };
}

export function redactUrl(
  value: string | undefined | null,
  settings: PrivacyRedactionSettings,
  artifact: RedactionArtifact = "url",
  field = "url",
): RedactionResult<string | undefined> {
  if (!value) {
    return { value: value || undefined, applied: [] };
  }

  const applied: RedactionHit[] = [];
  try {
    const parsed = new URL(value);
    if (parsed.username) {
      parsed.username = REDACTED_VALUE;
      applied.push(hit(artifact, "credential", "redacted", `${field}.username`, "url-username"));
    }
    if (parsed.password) {
      parsed.password = REDACTED_VALUE;
      applied.push(hit(artifact, "credential", "redacted", `${field}.password`, "url-password"));
    }

    if (settings.redactSensitiveQueryParams) {
      for (const [name, rawParamValue] of Array.from(parsed.searchParams.entries())) {
        const keyRule = classifyKey(name, "query", settings.privacyProfile);
        const valueResult = keyRule
          ? {
              value: REDACTED_VALUE,
              applied: [
                hit(
                  artifact,
                  keyRule.class,
                  "redacted",
                  `${field}.query.${sanitizeField(name)}`,
                  keyRule.id,
                ),
              ],
            }
          : redactPlainText(
              rawParamValue,
              settings,
              artifact,
              `${field}.query.${sanitizeField(name)}`,
              "query",
            );
        if (keyRule || valueResult.value !== rawParamValue) {
          parsed.searchParams.set(name, valueResult.value);
          applied.push(...valueResult.applied);
        }
      }
    }
    return { value: parsed.toString(), applied };
  } catch {
    return redactPlainText(value, settings, artifact, field, "query");
  }
}

export function redactBodyText(
  value: string | null | undefined,
  settings: PrivacyRedactionSettings,
  artifact: RedactionArtifact = "body",
  field = "body",
  target: RuleTarget = "body",
): RedactionResult<string | null> {
  if (value == null || value === "") {
    return { value: value ?? null, applied: [] };
  }

  const trimmed = value.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(value) as unknown;
      const result = redactJsonValue(parsed, settings, artifact, field, target);
      return {
        value: JSON.stringify(result.value),
        applied: result.applied,
      };
    } catch {
      // Fall back to plain-text rules when the body is not valid JSON.
    }
  }

  if (looksLikeFormUrlEncoded(trimmed)) {
    const applied: RedactionHit[] = [];
    const params = new URLSearchParams(value);
    for (const [name, rawParamValue] of Array.from(params.entries())) {
      const keyRule = classifyKey(name, target, settings.privacyProfile);
      if (keyRule) {
        params.set(name, REDACTED_VALUE);
        applied.push(
          hit(artifact, keyRule.class, "redacted", `${field}.${sanitizeField(name)}`, keyRule.id),
        );
        continue;
      }
      const valueResult = redactPlainText(
        rawParamValue,
        settings,
        artifact,
        `${field}.${sanitizeField(name)}`,
        target,
      );
      if (valueResult.value !== rawParamValue) {
        params.set(name, valueResult.value);
        applied.push(...valueResult.applied);
      }
    }
    if (applied.length > 0) {
      return { value: params.toString(), applied };
    }
  }

  return redactPlainText(value, settings, artifact, field, target);
}

export function redactConsoleEntry(
  entry: ConsoleEntry,
  settings: PrivacyRedactionSettings,
): RedactionResult<ConsoleEntry> {
  if (!settings.redactConsoleValues) {
    return { value: entry, applied: [] };
  }

  const cloned = cloneJson(entry);
  const applied: RedactionHit[] = [];
  if (cloned.message) {
    const result = redactPlainText(
      cloned.message,
      settings,
      "console",
      "console.message",
      "console",
    );
    cloned.message = result.value;
    applied.push(...result.applied);
  }
  if (cloned.url) {
    const result = redactUrl(cloned.url, settings, "console", "console.url");
    cloned.url = result.value;
    applied.push(...result.applied);
  }
  if (cloned.originalSource) {
    const result = redactUrl(cloned.originalSource, settings, "console", "console.originalSource");
    cloned.originalSource = result.value;
    applied.push(...result.applied);
  }
  if (cloned.args) {
    cloned.args = cloned.args.map((arg, index) => {
      const result = redactRemoteObject(arg, settings, `console.args.${index}`);
      applied.push(...result.applied);
      return result.value;
    });
  }
  if (cloned.stackTrace) {
    redactStackFrames(cloned.stackTrace, settings, "console.stack", applied);
  }
  if (cloned.sourceSnippet) {
    const result = redactSourceSnippet(cloned.sourceSnippet, settings, "console.sourceSnippet");
    cloned.sourceSnippet = result.value;
    applied.push(...result.applied);
  }
  return { value: cloned, applied };
}

function redactStackFrames(
  frames: StackFrame[],
  settings: PrivacyRedactionSettings,
  field: string,
  applied: RedactionHit[],
): void {
  for (const [index, frame] of frames.entries()) {
    if (frame.url) {
      const result = redactUrl(frame.url, settings, "console", `${field}.${index}.url`);
      frame.url = result.value || "";
      applied.push(...result.applied);
    }
    if (frame.originalSource) {
      const result = redactUrl(
        frame.originalSource,
        settings,
        "console",
        `${field}.${index}.originalSource`,
      );
      frame.originalSource = result.value;
      applied.push(...result.applied);
    }
    if (frame.sourceSnippet) {
      const result = redactSourceSnippet(
        frame.sourceSnippet,
        settings,
        `${field}.${index}.sourceSnippet`,
      );
      frame.sourceSnippet = result.value;
      applied.push(...result.applied);
    }
  }
}

export function redactUserEvent(
  event: RecordingUserEvent,
  settings: PrivacyRedactionSettings,
): RedactionResult<RecordingUserEvent> {
  if (!settings.redactEventMetadata) {
    return { value: event, applied: [] };
  }

  const cloned = cloneJson(event);
  const applied: RedactionHit[] = [];
  if (cloned.type === "navigation") {
    const url = redactUrl(cloned.url, settings, "events", "events.navigation.url");
    cloned.url = url.value || "";
    applied.push(...url.applied);
    if (cloned.title) {
      const title = redactPlainText(
        cloned.title,
        settings,
        "events",
        "events.navigation.title",
        "event",
      );
      cloned.title = title.value;
      applied.push(...title.applied);
    }
  } else {
    if ("selector" in cloned && cloned.selector) {
      const selector = redactPlainText(
        cloned.selector,
        settings,
        "events",
        `events.${cloned.type}.selector`,
        "event",
      );
      cloned.selector = selector.value;
      applied.push(...selector.applied);
    }
    if ((cloned.type === "click" || cloned.type === "contextmenu") && cloned.text) {
      const text = redactPlainText(
        cloned.text,
        settings,
        "events",
        `events.${cloned.type}.text`,
        "event",
      );
      cloned.text = text.value;
      applied.push(...text.applied);
    }
  }
  return { value: cloned, applied };
}

export function redactReport(
  report: RecordingReport,
  settings: PrivacyRedactionSettings,
): RedactionResult<RecordingReport> {
  const cloned = cloneJson(report);
  const applied: RedactionHit[] = [];
  const textFields: Array<
    ["title" | "description" | "expected" | "actual" | "reference", RuleTarget]
  > = [
    ["title", "report"],
    ["description", "report"],
    ["expected", "report"],
    ["actual", "report"],
    ["reference", "report"],
  ];
  for (const [key, target] of textFields) {
    const value = cloned[key];
    if (typeof value !== "string") {
      continue;
    }
    const result = redactPlainText(value, settings, "report", `report.${key}`, target);
    cloned[key] = result.value;
    applied.push(...result.applied);
  }
  const url = redactUrl(cloned.page.url, settings, "report", "report.page.url");
  cloned.page.url = url.value || "";
  applied.push(...url.applied);
  if (cloned.page.title) {
    const title = redactPlainText(
      cloned.page.title,
      settings,
      "report",
      "report.page.title",
      "report",
    );
    cloned.page.title = title.value;
    applied.push(...title.applied);
  }
  return { value: cloned, applied };
}

function redactPlainText(
  value: string,
  settings: PrivacyRedactionSettings,
  artifact: RedactionArtifact,
  field: string,
  target: RuleTarget,
): RedactionResult<string> {
  let output = value;
  const applied: RedactionHit[] = [];
  for (const rule of VALUE_RULES) {
    if (!isRuleEnabled(rule, settings.privacyProfile, target)) {
      continue;
    }
    output = output.replace(rule.pattern, (...args: unknown[]) => {
      const match = String(args[0] || "");
      if (!match) {
        return match;
      }
      applied.push(hit(artifact, rule.class, "redacted", field, rule.id));
      if (rule.id === "credential-assignment-value") {
        return `${args[1] || ""}${args[2] || ""}${REDACTED_VALUE}`;
      }
      if (rule.id === "bearer-token-value") {
        return `Bearer ${REDACTED_VALUE}`;
      }
      return REDACTED_VALUE;
    });
  }
  return { value: output, applied };
}

export function redactJsonValue(
  value: unknown,
  settings: PrivacyRedactionSettings,
  artifact: RedactionArtifact,
  field: string,
  target: RuleTarget,
): RedactionResult<unknown> {
  const applied: RedactionHit[] = [];
  const walk = (current: unknown, path: string, key?: string): unknown => {
    if (key) {
      const keyRule = classifyKey(key, target, settings.privacyProfile);
      if (keyRule) {
        applied.push(hit(artifact, keyRule.class, "redacted", sanitizeField(path), keyRule.id));
        return REDACTED_VALUE;
      }
    }

    if (typeof current === "string") {
      const result = redactPlainText(current, settings, artifact, sanitizeField(path), target);
      applied.push(...result.applied);
      return result.value;
    }
    if (Array.isArray(current)) {
      return current.map((item, index) => walk(item, `${path}.${index}`));
    }
    if (current && typeof current === "object") {
      const next: Record<string, unknown> = {};
      for (const [childKey, childValue] of Object.entries(current)) {
        next[childKey] = walk(childValue, `${path}.${childKey}`, childKey);
      }
      return next;
    }
    return current;
  };

  return { value: walk(value, field), applied };
}

function redactRemoteObject(
  value: SerializedRemoteObject,
  settings: PrivacyRedactionSettings,
  field: string,
): RedactionResult<SerializedRemoteObject> {
  const cloned = cloneJson(value);
  const applied: RedactionHit[] = [];
  if (typeof cloned.value === "string") {
    const result = redactPlainText(cloned.value, settings, "console", `${field}.value`, "console");
    cloned.value = result.value;
    applied.push(...result.applied);
  }
  if (cloned.description) {
    const result = redactPlainText(
      cloned.description,
      settings,
      "console",
      `${field}.description`,
      "console",
    );
    cloned.description = result.value;
    applied.push(...result.applied);
  }
  if (cloned.preview?.description) {
    const result = redactPlainText(
      cloned.preview.description,
      settings,
      "console",
      `${field}.preview.description`,
      "console",
    );
    cloned.preview.description = result.value;
    applied.push(...result.applied);
  }
  if (cloned.stackTrace) {
    redactStackFrames(cloned.stackTrace, settings, `${field}.stack`, applied);
  }
  if (cloned.preview?.properties) {
    for (const [index, property] of cloned.preview.properties.entries()) {
      const keyRule = classifyKey(property.name, "console", settings.privacyProfile);
      if (keyRule) {
        property.value = REDACTED_VALUE;
        property.valuePreview = undefined;
        applied.push(
          hit(
            "console",
            keyRule.class,
            "redacted",
            `${field}.preview.properties.${sanitizeField(property.name)}`,
            keyRule.id,
          ),
        );
        continue;
      }
      if (property.value) {
        const result = redactPlainText(
          property.value,
          settings,
          "console",
          `${field}.preview.properties.${index}`,
          "console",
        );
        property.value = result.value;
        applied.push(...result.applied);
      }
      if (property.valuePreview) {
        const nested = redactRemoteObject(
          { type: property.valuePreview.type, preview: property.valuePreview },
          settings,
          `${field}.preview.properties.${index}.valuePreview`,
        );
        property.valuePreview = nested.value.preview;
        applied.push(...nested.applied);
      }
    }
  }
  return { value: cloned, applied };
}

function redactSourceSnippet(
  snippet: SourceCodeSnippet,
  settings: PrivacyRedactionSettings,
  field: string,
): RedactionResult<SourceCodeSnippet> {
  const cloned = cloneJson(snippet);
  const applied: RedactionHit[] = [];
  if (settings.privacyProfile !== "strict") {
    return { value: cloned, applied };
  }
  cloned.lines = cloned.lines.map((line, index) => {
    const result = redactPlainText(line, settings, "console", `${field}.lines.${index}`, "console");
    applied.push(...result.applied);
    return result.value;
  });
  return { value: cloned, applied };
}

function classifyKey(
  key: string,
  target: RuleTarget,
  profile: PrivacyProfile,
): ClassifiedRule | null {
  return (
    KEY_RULES.find((rule) => isRuleEnabled(rule, profile, target) && rule.pattern.test(key)) || null
  );
}

function isRuleEnabled(rule: ClassifiedRule, profile: PrivacyProfile, target: RuleTarget): boolean {
  return rule.profiles.includes(profile) && rule.targets.includes(target);
}

function hit(
  artifact: RedactionArtifact,
  redactionClass: RedactionClass,
  action: RedactionHit["action"],
  field: string | undefined,
  ruleId: string,
): RedactionHit {
  return {
    artifact,
    class: redactionClass,
    action,
    ...(field ? { field: sanitizeField(field) } : {}),
    ruleId,
  };
}

function sanitizeField(value: string): string {
  return value.replace(/[^\w.:[\]-]/g, "_").slice(0, 120);
}

function looksLikeFormUrlEncoded(value: string): boolean {
  return value.includes("=") && !value.includes("\n") && /^[^=]+=.*/.test(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
