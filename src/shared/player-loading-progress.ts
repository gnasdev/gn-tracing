/**
 * Pure loading-progress aggregation for the player download UI.
 *
 * DOM rendering stays in the shell; this module owns totals / percent math.
 */

export type LoadingProgressStatus = "queued" | "loading" | "loaded" | "failed";

export interface LoadingProgressEntry {
  loaded: number;
  total: number;
  group: string;
  label: string;
  status: LoadingProgressStatus;
}

export function normalizeLoadingStatus(status: unknown): LoadingProgressStatus {
  const raw = String(status || "queued").toLowerCase();
  if (raw === "queued" || raw === "loaded" || raw === "failed" || raw === "loading") {
    return raw;
  }
  return "queued";
}

export interface LoadingProgressSnapshot {
  uploadedBytes: number;
  totalBytes: number;
  percent: number;
}

/**
 * Aggregate Map values into uploaded/total bytes and a 0–100 percent.
 * Video group uses expectedVideoBytes as a floor when partial totals are known.
 */
export function aggregateLoadingProgress(
  entries: Iterable<LoadingProgressEntry>,
  expectedVideoBytes = 0,
): LoadingProgressSnapshot {
  const list = Array.from(entries);
  const uploadedBytes = list.reduce(
    (sum, entry) => sum + (entry.total > 0 ? Math.min(entry.loaded, entry.total) : 0),
    0,
  );
  const videoLoadedBytes = list
    .filter((entry) => entry.group === "video")
    .reduce((sum, entry) => sum + (entry.total > 0 ? Math.min(entry.loaded, entry.total) : 0), 0);
  const videoKnownTotalBytes = list
    .filter((entry) => entry.group === "video")
    .reduce((sum, entry) => sum + entry.total, 0);
  const otherTotalBytes = list
    .filter((entry) => entry.group !== "video")
    .reduce((sum, entry) => sum + entry.total, 0);
  const expected =
    Number.isFinite(expectedVideoBytes) && expectedVideoBytes > 0 ? expectedVideoBytes : 0;
  const totalBytes = Math.max(videoKnownTotalBytes, expected, videoLoadedBytes) + otherTotalBytes;
  const percent =
    totalBytes > 0 ? Math.max(0, Math.min(100, (uploadedBytes / totalBytes) * 100)) : 0;
  return { uploadedBytes, totalBytes, percent };
}

export function mergeLoadingEntry(
  previous: LoadingProgressEntry | undefined,
  key: string,
  patch: {
    loaded?: number;
    total?: number;
    group?: string;
    label?: string;
    status?: unknown;
  },
): LoadingProgressEntry {
  const base: LoadingProgressEntry = previous || {
    loaded: 0,
    total: 0,
    group: patch.group || "other",
    label: patch.label || key,
    status: "queued",
  };
  return {
    loaded: Math.max(0, patch.loaded ?? base.loaded),
    total: Math.max(0, patch.total || base.total || 0),
    group: patch.group || base.group,
    label: patch.label || base.label || key,
    status: normalizeLoadingStatus(patch.status || base.status || "queued"),
  };
}
