/**
 * Test data factories.
 *
 * Construct valid domain objects with sensible defaults and override hooks so
 * tests stay readable and property generators have building blocks to compose.
 *
 * The privacy factories moved to `packages/replay-core/src/testing/factories.ts`
 * alongside the redaction policy they build inputs for; they are re-exported
 * here so extension tests keep one import path.
 */
import type { RecordingTabLike } from "../src/shared/recording-target";

export {
  makeHeaderMap,
  makePrivacySettings,
} from "../packages/replay-core/src/testing/factories";

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
