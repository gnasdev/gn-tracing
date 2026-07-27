/**
 * Test data factories for the shared recording format.
 *
 * These live in the core rather than in the extension's `test/` tree because
 * the redaction policy they build inputs for now lives here too, and a core
 * whose tests reach back into the repo root could not be reasoned about — or
 * eventually extracted — on its own.
 */

import { getPrivacyProfileSettings } from "../redact/privacy-redaction";
import type { PrivacyProfile, PrivacyRedactionSettings } from "../schema/privacy";

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
