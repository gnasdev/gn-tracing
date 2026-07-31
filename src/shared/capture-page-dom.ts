/**
 * One-shot page DOM snapshot for screenshot reports.
 *
 * Distinct from Instant Replay: a single tree into `dom.json`, not a rolling
 * lookback buffer and not console/network evidence.
 */

export const CAPTURE_PAGE_DOM_SNAPSHOT_ACTION = "CAPTURE_PAGE_DOM_SNAPSHOT" as const;
