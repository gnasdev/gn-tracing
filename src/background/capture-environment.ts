/**
 * Capture environment normalization and browser detection.
 */
import type { CaptureEnvironment, RecordingUserEvent } from "../types/recording";

const MAX_EVENT_STRING_LENGTH = 160;

export function truncateEventString(
  value: unknown,
  limit = MAX_EVENT_STRING_LENGTH,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
}

export function normalizeFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function parseBrowserFromUserAgent(userAgent: string): {
  browserName?: string;
  browserVersion?: string;
} {
  const matchers: Array<[string, RegExp]> = [
    ["Edge", /Edg\/([0-9.]+)/],
    ["Chrome", /Chrome\/([0-9.]+)/],
    ["Firefox", /Firefox\/([0-9.]+)/],
    ["Safari", /Version\/([0-9.]+).*Safari/],
  ];

  for (const [browserName, pattern] of matchers) {
    const match = userAgent.match(pattern);
    if (match?.[1]) {
      return { browserName, browserVersion: match[1] };
    }
  }

  return {};
}

export function buildFallbackEnvironment(): CaptureEnvironment {
  const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : "";
  return {
    extensionVersion: chrome.runtime.getManifest().version,
    userAgent,
    language: typeof navigator !== "undefined" ? navigator.language : "",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
    ...parseBrowserFromUserAgent(userAgent),
  };
}

export function normalizeCaptureEnvironment(value: unknown): CaptureEnvironment | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const userAgent = truncateEventString(raw.userAgent, 512) || "";
  const viewport =
    raw.viewport && typeof raw.viewport === "object"
      ? (raw.viewport as Record<string, unknown>)
      : null;
  const screen =
    raw.screen && typeof raw.screen === "object" ? (raw.screen as Record<string, unknown>) : null;

  return {
    extensionVersion: chrome.runtime.getManifest().version,
    userAgent,
    language: truncateEventString(raw.language, 64) || "",
    timezone: truncateEventString(raw.timezone, 96) || "",
    ...parseBrowserFromUserAgent(userAgent),
    ...(viewport
      ? {
          viewport: {
            width: Math.max(0, Math.round(normalizeFiniteNumber(viewport.width) || 0)),
            height: Math.max(0, Math.round(normalizeFiniteNumber(viewport.height) || 0)),
            devicePixelRatio: Math.max(0, normalizeFiniteNumber(viewport.devicePixelRatio) || 1),
          },
        }
      : {}),
    ...(screen
      ? {
          screen: {
            width: Math.max(0, Math.round(normalizeFiniteNumber(screen.width) || 0)),
            height: Math.max(0, Math.round(normalizeFiniteNumber(screen.height) || 0)),
          },
        }
      : {}),
  };
}

export function normalizeRecordingUserEvent(value: unknown): RecordingUserEvent | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const timestamp = normalizeFiniteNumber(raw.timestamp);
  if (!timestamp) {
    return null;
  }

  switch (raw.type) {
    case "navigation": {
      const url = truncateEventString(raw.url, 2048);
      if (!url) {
        return null;
      }
      return {
        type: "navigation",
        timestamp,
        url,
        title: truncateEventString(raw.title, 160),
      };
    }
    case "click":
      return {
        type: "click",
        timestamp,
        selector: truncateEventString(raw.selector),
        text: truncateEventString(raw.text),
        role: truncateEventString(raw.role, 64),
        x: normalizeFiniteNumber(raw.x),
        y: normalizeFiniteNumber(raw.y),
      };
    case "focus":
      return {
        type: "focus",
        timestamp,
        selector: truncateEventString(raw.selector),
        inputType: truncateEventString(raw.inputType, 64),
      };
    case "submit":
      return {
        type: "submit",
        timestamp,
        selector: truncateEventString(raw.selector),
      };
    default:
      return null;
  }
}
