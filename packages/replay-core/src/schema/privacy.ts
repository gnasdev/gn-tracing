/**
 * Privacy settings that shape what a producer is allowed to capture.
 *
 * These sit in the schema rather than in the extension's message types because
 * the redaction policy in `../redact/` consumes them and every producer must
 * apply that same policy. An SDK that invented its own settings shape would end
 * up with its own redaction rules, which is the one divergence that would
 * actually leak user data.
 */

export type PrivacyProfile = "standard" | "strict" | "custom";

export type WebSocketPayloadRedactionMode = "off" | "sensitive-fields" | "all";

export interface PrivacyRedactionSettings {
  privacyProfile: PrivacyProfile;
  redactSensitiveHeaders: boolean;
  redactSensitiveQueryParams: boolean;
  redactRequestBodyFields: boolean;
  redactResponseBodyFields: boolean;
  redactConsoleValues: boolean;
  redactWebSocketPayloads: WebSocketPayloadRedactionMode;
  redactEventMetadata: boolean;
  maskDomSelectors: string[];
}
