/**
 * Ephemeral page instrumentation for a single GN Tracing recording session.
 *
 * The service worker injects this file only after the user starts recording a
 * tab. It captures interaction summaries, never raw typed input, then removes
 * listeners when the recording stops or when a new session starts in the same
 * page context.
 */

import {
  getPrivacyProfileSettings,
  normalizeMaskDomSelectors,
  redactUserEvent,
} from "../shared/privacy-redaction";
import type { PrivacyRedactionSettings } from "../types/messages";
import type { RecordingUserEvent, RedactionHit } from "../types/recording";

(() => {
  type RecordingEventState = {
    sessionId: string;
    privacySettings: PrivacyRedactionSettings;
    maskStyle?: HTMLStyleElement;
    cleanup: () => void;
  };

  type RecordingWindow = Window & {
    __gnTracingEventCapture?: RecordingEventState;
    __gnTracingEventCaptureListenerInstalled?: boolean;
  };

  const EVENT_TEXT_LIMIT = 80;
  const SELECTOR_PART_LIMIT = 48;
  const SENSITIVE_NAME_PATTERN =
    /(password|passwd|pwd|token|secret|api[-_]?key|authorization|auth|credential|session)/i;
  const DEFAULT_PRIVACY_SETTINGS = getPrivacyProfileSettings("standard");
  const pageWindow = window as RecordingWindow;

  function escapeSelector(value: string): string {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
      return CSS.escape(value);
    }
    return value.replace(/["\\#.:,[\]\s>+~]/g, "\\$&");
  }

  function trimText(value: string, limit = EVENT_TEXT_LIMIT): string {
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized;
  }

  function getElement(target: EventTarget | null): Element | null {
    return target instanceof Element ? target : null;
  }

  function isFormControl(element: Element | null): boolean {
    return Boolean(
      element?.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']"),
    );
  }

  function isSensitiveElement(element: Element | null): boolean {
    const field = element?.closest("input, textarea, select") as
      | HTMLInputElement
      | HTMLTextAreaElement
      | HTMLSelectElement
      | null;
    if (!field) {
      return false;
    }

    if (field instanceof HTMLInputElement && field.type === "password") {
      return true;
    }

    const haystack = [
      field.id,
      field.name,
      field.autocomplete,
      field.getAttribute("aria-label"),
      field.getAttribute("placeholder"),
    ]
      .filter(Boolean)
      .join(" ");
    return SENSITIVE_NAME_PATTERN.test(haystack);
  }

  function getSelector(element: Element | null): string | undefined {
    if (!element) {
      return undefined;
    }

    const parts: string[] = [];
    let current: Element | null = element;

    while (current && current !== document.documentElement && parts.length < 4) {
      const tag = current.tagName.toLowerCase();
      const testId = current.getAttribute("data-testid") || current.getAttribute("data-test-id");
      const id = current.id;
      const className =
        typeof current.className === "string"
          ? current.className.split(/\s+/).filter(Boolean).slice(0, 2).join(".")
          : "";

      if (testId) {
        parts.unshift(`${tag}[data-testid="${trimText(testId, SELECTOR_PART_LIMIT)}"]`);
        break;
      }
      if (id) {
        parts.unshift(`${tag}#${escapeSelector(trimText(id, SELECTOR_PART_LIMIT))}`);
        break;
      }
      if (className) {
        parts.unshift(
          `${tag}.${className
            .split(".")
            .map((part) => escapeSelector(trimText(part, SELECTOR_PART_LIMIT)))
            .join(".")}`,
        );
      } else {
        parts.unshift(tag);
      }

      current = current.parentElement;
    }

    return parts.join(" > ") || undefined;
  }

  function getElementRole(element: Element | null): string | undefined {
    if (!element) {
      return undefined;
    }
    return element.getAttribute("role") || element.tagName.toLowerCase();
  }

  function getSafeClickText(element: Element | null): string | undefined {
    if (!element || isFormControl(element) || isSensitiveElement(element)) {
      return undefined;
    }
    const ariaLabel = element.getAttribute("aria-label");
    const title = element.getAttribute("title");
    const text = ariaLabel || title || element.textContent || "";
    const safeText = trimText(text);
    return safeText || undefined;
  }

  function getInputType(element: Element | null): string | undefined {
    const field = element?.closest("input, textarea, select") as
      | HTMLInputElement
      | HTMLTextAreaElement
      | HTMLSelectElement
      | null;
    if (!field) {
      return undefined;
    }
    return field instanceof HTMLInputElement ? field.type || "text" : field.tagName.toLowerCase();
  }

  function getEnvironment() {
    return {
      userAgent: navigator.userAgent,
      language: navigator.language,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
      },
      screen: {
        width: window.screen.width,
        height: window.screen.height,
      },
    };
  }

  // After an extension reload this stale capture instance keeps running in the
  // page but its chrome.runtime is gone; sendMessage then throws synchronously
  // ("Extension context invalidated"), so guard and swallow instead of spamming
  // uncaught errors into the recorded page's console.
  function sendRuntimeMessage(message: Record<string, unknown>): void {
    if (!chrome.runtime?.id) {
      return;
    }
    try {
      chrome.runtime.sendMessage(message).catch(() => {});
    } catch {
      // Extension context invalidated between the guard and the call.
    }
  }

  function sendSessionEvent(
    sessionId: string,
    payload: Record<string, unknown>,
    redactionHits: RedactionHit[] = [],
  ): void {
    sendRuntimeMessage({
      target: "service-worker",
      action: "RECORDING_USER_EVENT",
      data: {
        sessionId,
        ...(redactionHits.length > 0 ? { redactionHits } : {}),
        ...payload,
      },
    });
  }

  function sendPrivacyLimitations(sessionId: string, limitations: string[]): void {
    if (limitations.length === 0) {
      return;
    }
    sendRuntimeMessage({
      target: "service-worker",
      action: "RECORDING_USER_EVENT",
      data: {
        sessionId,
        limitations,
      },
    });
  }

  function sanitizeEvent(
    event: RecordingUserEvent,
    privacySettings: PrivacyRedactionSettings,
  ): {
    event: RecordingUserEvent;
    redactionHits: RedactionHit[];
  } {
    const redacted = redactUserEvent(event, privacySettings);
    return {
      event: redacted.value,
      redactionHits: redacted.applied,
    };
  }

  function applyDomMasks(
    sessionId: string,
    privacySettings: PrivacyRedactionSettings,
  ): HTMLStyleElement | undefined {
    const selectors = normalizeMaskDomSelectors(privacySettings.maskDomSelectors);
    if (selectors.length === 0) {
      return undefined;
    }

    const validSelectors: string[] = [];
    const invalidSelectors: string[] = [];
    for (const selector of selectors) {
      try {
        document.querySelector(selector);
        validSelectors.push(selector);
      } catch {
        invalidSelectors.push(selector);
      }
    }
    if (invalidSelectors.length > 0) {
      sendPrivacyLimitations(sessionId, [
        `Some visual masking selectors were invalid and were skipped (${invalidSelectors.length}).`,
      ]);
    }
    if (validSelectors.length === 0) {
      return undefined;
    }

    const style = document.createElement("style");
    style.id = "gn-tracing-privacy-mask";
    style.textContent = `
${validSelectors.join(",\n")} {
  filter: blur(9px) !important;
  color: transparent !important;
  text-shadow: 0 0 10px rgba(0, 0, 0, 0.95) !important;
  caret-color: transparent !important;
}`;
    document.documentElement.appendChild(style);
    return style;
  }

  function install(sessionId: string, privacySettings: PrivacyRedactionSettings): void {
    pageWindow.__gnTracingEventCapture?.cleanup();
    const maskStyle = applyDomMasks(sessionId, privacySettings);

    const sendNavigation = (): void => {
      const sanitized = sanitizeEvent(
        {
          type: "navigation",
          timestamp: Date.now(),
          url: window.location.href,
          title: document.title || undefined,
        },
        privacySettings,
      );
      sendSessionEvent(
        sessionId,
        {
          environment: getEnvironment(),
          event: sanitized.event,
        },
        sanitized.redactionHits,
      );
    };

    const onClick = (event: MouseEvent): void => {
      const element = getElement(event.target);
      const sanitized = sanitizeEvent(
        {
          type: "click",
          timestamp: Date.now(),
          selector: getSelector(element),
          text: getSafeClickText(element),
          role: getElementRole(element),
          x: Math.round(event.clientX),
          y: Math.round(event.clientY),
        },
        privacySettings,
      );
      sendSessionEvent(
        sessionId,
        {
          event: sanitized.event,
        },
        sanitized.redactionHits,
      );
    };

    const onContextMenu = (event: MouseEvent): void => {
      const element = getElement(event.target);
      const sanitized = sanitizeEvent(
        {
          type: "contextmenu",
          timestamp: Date.now(),
          selector: getSelector(element),
          text: getSafeClickText(element),
          role: getElementRole(element),
          x: Math.round(event.clientX),
          y: Math.round(event.clientY),
        },
        privacySettings,
      );
      sendSessionEvent(
        sessionId,
        {
          event: sanitized.event,
        },
        sanitized.redactionHits,
      );
    };

    let wheelBurst: {
      timestamp: number;
      x: number;
      y: number;
      selector?: string;
      accumulatedDeltaY: number;
      flushTimer: ReturnType<typeof window.setTimeout>;
    } | null = null;

    const flushWheelBurst = (): void => {
      if (!wheelBurst) {
        return;
      }
      const burst = wheelBurst;
      wheelBurst = null;
      window.clearTimeout(burst.flushTimer);
      const sanitized = sanitizeEvent(
        {
          type: "scroll",
          timestamp: burst.timestamp,
          selector: burst.selector,
          x: burst.x,
          y: burst.y,
          direction: burst.accumulatedDeltaY < 0 ? "up" : "down",
          deltaY: Math.round(burst.accumulatedDeltaY),
        },
        privacySettings,
      );
      sendSessionEvent(
        sessionId,
        {
          event: sanitized.event,
        },
        sanitized.redactionHits,
      );
    };

    const WHEEL_BURST_IDLE_MS = 400;

    const onWheel = (event: WheelEvent): void => {
      const element = getElement(event.target);
      const directionChanged =
        wheelBurst !== null &&
        Math.sign(wheelBurst.accumulatedDeltaY) !== 0 &&
        Math.sign(event.deltaY) !== 0 &&
        Math.sign(wheelBurst.accumulatedDeltaY) !== Math.sign(event.deltaY);

      if (directionChanged) {
        flushWheelBurst();
      }

      if (!wheelBurst) {
        wheelBurst = {
          timestamp: Date.now(),
          x: Math.round(event.clientX),
          y: Math.round(event.clientY),
          selector: getSelector(element),
          accumulatedDeltaY: 0,
          flushTimer: window.setTimeout(flushWheelBurst, WHEEL_BURST_IDLE_MS),
        };
      } else {
        window.clearTimeout(wheelBurst.flushTimer);
        wheelBurst.flushTimer = window.setTimeout(flushWheelBurst, WHEEL_BURST_IDLE_MS);
      }

      wheelBurst.accumulatedDeltaY += event.deltaY;
    };

    const onFocus = (event: FocusEvent): void => {
      const element = getElement(event.target);
      const sanitized = sanitizeEvent(
        {
          type: "focus",
          timestamp: Date.now(),
          selector: getSelector(element),
          inputType: getInputType(element),
        },
        privacySettings,
      );
      sendSessionEvent(
        sessionId,
        {
          event: sanitized.event,
        },
        sanitized.redactionHits,
      );
    };

    const onSubmit = (event: SubmitEvent): void => {
      const element = getElement(event.target);
      const sanitized = sanitizeEvent(
        {
          type: "submit",
          timestamp: Date.now(),
          selector: getSelector(element),
        },
        privacySettings,
      );
      sendSessionEvent(
        sessionId,
        {
          event: sanitized.event,
        },
        sanitized.redactionHits,
      );
    };

    const onLocationChange = (): void => {
      window.setTimeout(sendNavigation, 0);
    };

    document.addEventListener("click", onClick, true);
    document.addEventListener("contextmenu", onContextMenu, true);
    document.addEventListener("wheel", onWheel, { capture: true, passive: true });
    document.addEventListener("focusin", onFocus, true);
    document.addEventListener("submit", onSubmit, true);
    window.addEventListener("hashchange", onLocationChange);
    window.addEventListener("popstate", onLocationChange);
    window.addEventListener("pageshow", sendNavigation);
    sendNavigation();

    pageWindow.__gnTracingEventCapture = {
      sessionId,
      privacySettings,
      maskStyle,
      cleanup: () => {
        document.removeEventListener("click", onClick, true);
        document.removeEventListener("contextmenu", onContextMenu, true);
        document.removeEventListener("wheel", onWheel, { capture: true });
        flushWheelBurst();
        document.removeEventListener("focusin", onFocus, true);
        document.removeEventListener("submit", onSubmit, true);
        window.removeEventListener("hashchange", onLocationChange);
        window.removeEventListener("popstate", onLocationChange);
        window.removeEventListener("pageshow", sendNavigation);
        maskStyle?.remove();
        delete pageWindow.__gnTracingEventCapture;
      },
    };
  }

  if (!pageWindow.__gnTracingEventCaptureListenerInstalled) {
    chrome.runtime.onMessage.addListener(
      (
        message: {
          target?: string;
          type?: string;
          sessionId?: string;
          privacySettings?: PrivacyRedactionSettings;
        },
        _sender,
        sendResponse,
      ) => {
        if (message.target !== "recording-events") {
          return false;
        }

        if (
          message.type === "START" &&
          typeof message.sessionId === "string" &&
          message.sessionId
        ) {
          install(message.sessionId, message.privacySettings || DEFAULT_PRIVACY_SETTINGS);
          sendResponse({ ok: true });
          return false;
        }

        if (message.type === "STOP") {
          pageWindow.__gnTracingEventCapture?.cleanup();
          sendResponse({ ok: true });
          return false;
        }

        return false;
      },
    );
    pageWindow.__gnTracingEventCaptureListenerInstalled = true;
  }
})();
