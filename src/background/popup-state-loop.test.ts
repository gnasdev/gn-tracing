/**
 * Popup state write loop regression.
 *
 * A closed cycle used to spin the extension forever once the popup was open and
 * any non-progress state change landed:
 *
 *   saveStateToStorage() → chrome.storage.session.onChanged
 *     → popup handleStateUpdate() → refreshAllProviderStatuses()
 *     → STORAGE_STATUS message → storageStatus handler → saveStateToStorage() → …
 *
 * It only surfaced after an upload finished because `handleStateUpdate` returns
 * early for progress-only updates, which suppressed it during the upload itself.
 *
 * Two independent guards are asserted here, so breaking one does not silently
 * restore the loop: the read-only handler must not broadcast, and the writer must
 * skip no-op writes.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const swSource = readFileSync(resolve(__dirname, "service-worker.ts"), "utf8");
const popupSource = readFileSync(resolve(__dirname, "../popup/popup.ts"), "utf8");

/** Body of `storageStatus: async (data) => { … }` inside the handler object. */
function storageStatusHandler(): string {
  const start = swSource.indexOf("storageStatus: async (data) =>");
  expect(start).toBeGreaterThan(-1);
  const end = swSource.indexOf("getStorageToken:", start);
  expect(end).toBeGreaterThan(start);
  return swSource.slice(start, end);
}

/** Drop `//` comments so a negative assertion cannot match explanatory prose. */
function withoutComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

function saveStateFunction(): string {
  const start = swSource.indexOf("async function saveStateToStorage()");
  expect(start).toBeGreaterThan(-1);
  const end = swSource.indexOf("function notifyPopupStateUpdated", start);
  expect(end).toBeGreaterThan(start);
  return swSource.slice(start, end);
}

describe("popup state write loop", () => {
  it("the popup still re-queries provider status on every state update", () => {
    // This is the other half of the cycle. If it ever stops being true the
    // guards below are load-bearing for a different reason, so keep it pinned.
    expect(popupSource).toContain("function handleStateUpdate");
    expect(popupSource).toContain("void refreshAllProviderStatuses()");
    expect(popupSource).toContain('action: "STORAGE_STATUS"');
  });

  it("STORAGE_STATUS is read-only and never broadcasts state", () => {
    const handler = storageStatusHandler();
    // It must still answer the query.
    expect(handler).toContain("return { ok: true, isConnected }");
    // …but writing state here is what closed the loop.
    const code = withoutComments(handler);
    expect(code).not.toContain("saveStateToStorage");
    expect(code).not.toContain("notifyPopupStateUpdated");
  });

  it("state writes are skipped when nothing meaningful changed", () => {
    const save = saveStateFunction();
    expect(save).toContain("popupStateIdentity");
    expect(save).toContain("lastPersistedStateJson");
    // The early return is what stops a redundant onChanged notification.
    expect(save).toMatch(/if \(identity === lastPersistedStateJson\)\s*\{\s*return popupState;/);
  });

  it("the identity key ignores the clock-derived elapsed fields", () => {
    const start = swSource.indexOf("function popupStateIdentity");
    expect(start).toBeGreaterThan(-1);
    const identity = swSource.slice(start, swSource.indexOf("async function saveStateToStorage"));
    // buildPopupState() stamps these from Date.now() on every call, so leaving
    // them in the key would make every state look new and defeat the guard.
    expect(identity).toContain("elapsedMs: 0");
    expect(identity).toContain("elapsedUpdatedAt: 0");
  });

  it("genuine connection changes are still broadcast", () => {
    // storageConnect / storageDisconnect mutate real state and must keep writing.
    const connectStart = swSource.indexOf("storageConnect: async (data) =>");
    const connectEnd = swSource.indexOf("storageStatus: async (data) =>", connectStart);
    const connectAndDisconnect = swSource.slice(connectStart, connectEnd);
    expect(connectAndDisconnect).toContain("storageDisconnect");
    expect(connectAndDisconnect.match(/saveStateToStorage\(\)/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
