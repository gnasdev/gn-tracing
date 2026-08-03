/**
 * Storage panel start↔stop key diff (player Resources/Storage tab).
 *
 * Pure: no DOM. Every key in start∪stop yields exactly one row (P4 / R5.2).
 */

export type StorageDiffItem = { key: string; value: string };

export type StorageDiffRow =
  | { key: string; status: "added"; value: string }
  | { key: string; status: "removed"; value: string }
  | { key: string; status: "unchanged"; value: string }
  | { key: string; status: "changed"; from: string; to: string };

/**
 * Build a one-row-per-key diff between two storage groups.
 */
export function diffStorageGroups(
  startItems: StorageDiffItem[] | null | undefined,
  stopItems: StorageDiffItem[] | null | undefined,
): StorageDiffRow[] {
  const startMap = new Map((startItems || []).map((it) => [it.key, it.value]));
  const stopMap = new Map((stopItems || []).map((it) => [it.key, it.value]));
  const rows: StorageDiffRow[] = [];
  for (const [key, value] of stopMap) {
    if (!startMap.has(key)) {
      rows.push({ key, status: "added", value });
    } else if (startMap.get(key) !== value) {
      rows.push({ key, status: "changed", from: startMap.get(key) as string, to: value });
    } else {
      rows.push({ key, status: "unchanged", value });
    }
  }
  for (const [key, value] of startMap) {
    if (!stopMap.has(key)) {
      rows.push({ key, status: "removed", value });
    }
  }
  return rows;
}

/**
 * Normalize a snapshot group into `{ key, value }` rows.
 * Cookies use cookie `name` as the diff key.
 */
export function toStorageItems(
  snapshot: Record<string, unknown> | null | undefined,
  group: string,
): StorageDiffItem[] {
  if (!snapshot) {
    return [];
  }
  const raw = Array.isArray(snapshot[group]) ? (snapshot[group] as unknown[]) : [];
  if (group === "cookies") {
    return raw.map((c) => {
      const cookie = c as { name?: string; value?: string } | null;
      return { key: cookie?.name ?? "", value: cookie?.value ?? "" };
    });
  }
  return raw.map((kv) => {
    const item = kv as { key?: string; value?: string } | null;
    return { key: item?.key ?? "", value: item?.value ?? "" };
  });
}
