/**
 * Test data factories.
 *
 * Construct valid domain objects with sensible defaults and override hooks so
 * tests stay readable and property generators have building blocks to compose.
 */
import { getPrivacyProfileSettings } from "../src/shared/privacy-redaction";
import type { RecordingTabLike } from "../src/shared/recording-target";
import type { PrivacyProfile, PrivacyRedactionSettings } from "../src/types/messages";

/**
 * Build a valid {@link RecordingTabLike} that passes recording-target
 * validation by default (numeric id + recordable https URL). Pass `overrides`
 * to construct edge cases such as missing ids or unsupported URLs.
 */
export function makeTab(overrides?: Partial<RecordingTabLike>): RecordingTabLike {
  return {
    id: 1,
    url: "https://example.com/",
    ...overrides,
  };
}

/**
 * Build the canonical {@link PrivacyRedactionSettings} for a privacy profile,
 * defaulting to the `standard` profile. Delegates to the production accessor so
 * factory output always matches the real policy.
 */
export function makePrivacySettings(
  profile: PrivacyProfile = "standard",
): PrivacyRedactionSettings {
  return getPrivacyProfileSettings(profile);
}

/**
 * Build a header map containing a representative mix of sensitive and benign
 * headers. Override hooks merge on top of (and can remove via reassignment)
 * the defaults to construct specific scenarios.
 */
export function makeHeaderMap(overrides?: Record<string, string>): Record<string, string> {
  return {
    authorization: "Bearer test-token-value",
    "content-type": "application/json",
    accept: "application/json",
    "user-agent": "gn-tracing-tests",
    ...overrides,
  };
}
