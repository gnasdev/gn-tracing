/**
 * `runtime-state.ts` behavior: these functions had no direct test coverage
 * while they lived inline in `service-worker.ts`. Each test resets the module's
 * session list first since the state is process-wide (mirroring the real
 * service worker, which has exactly one of each).
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { RecordingSessionSummary } from "../types/messages";
import {
  activeRecording,
  addActivePrivacyLimitation,
  getSession,
  getSessionArtifacts,
  getSessions,
  patchSession,
  recordActiveRedactionHits,
  setSession,
  setSessionArtifacts,
  setSessions,
  sortSessions,
} from "./runtime-state";

function session(overrides: Partial<RecordingSessionSummary> = {}): RecordingSessionSummary {
  return {
    id: "s-1",
    phase: "recorded",
    startTime: 1,
    stopTime: 2,
    items: [],
    hasLocalSnapshot: true,
    ...overrides,
  } as RecordingSessionSummary;
}

beforeEach(() => {
  setSessions([]);
  setSessionArtifacts({});
  activeRecording.sessionId = null;
  activeRecording.redactionHits = [];
  activeRecording.privacyLimitations = [];
});

describe("sortSessions", () => {
  it("orders by stopTime, falling back to startTime, most recent first", () => {
    const items = [
      session({ id: "a", startTime: 10, stopTime: 20 }),
      session({ id: "b", startTime: 30, stopTime: undefined }),
      session({ id: "c", startTime: 5, stopTime: 40 }),
    ];
    expect(sortSessions(items).map((s) => s.id)).toEqual(["c", "b", "a"]);
  });

  it("does not mutate the input array", () => {
    const items = [session({ id: "a", stopTime: 1 }), session({ id: "b", stopTime: 2 })];
    const original = [...items];
    sortSessions(items);
    expect(items).toEqual(original);
  });
});

describe("getSession / setSession", () => {
  it("inserts a new session and keeps the list sorted", () => {
    setSession(session({ id: "old", stopTime: 1 }));
    setSession(session({ id: "new", stopTime: 2 }));
    expect(getSessions().map((s) => s.id)).toEqual(["new", "old"]);
  });

  it("replaces an existing session with the same id instead of duplicating it", () => {
    setSession(session({ id: "s-1", phase: "recorded" }));
    setSession(session({ id: "s-1", phase: "uploaded" }));
    expect(getSessions()).toHaveLength(1);
    expect(getSession("s-1")?.phase).toBe("uploaded");
  });
});

describe("patchSession", () => {
  it("merges the patch onto the existing session and persists it", () => {
    setSession(session({ id: "s-1", phase: "recorded" }));
    const updated = patchSession("s-1", { phase: "uploading", progress: 42 });
    expect(updated?.phase).toBe("uploading");
    expect(updated?.progress).toBe(42);
    expect(getSession("s-1")?.phase).toBe("uploading");
  });

  it("returns null for a session id that does not exist", () => {
    expect(patchSession("missing", { phase: "uploaded" })).toBeNull();
  });

  it("clones progress items so later mutation of the source array is not reflected", () => {
    const items = [{ status: "pending" } as never];
    setSession(session({ id: "s-1", items: [] }));
    patchSession("s-1", { items });
    items.push({ status: "another" } as never);
    expect(getSession("s-1")?.items).toHaveLength(1);
  });
});

describe("recordActiveRedactionHits", () => {
  it("does nothing without an active session id", () => {
    activeRecording.sessionId = null;
    recordActiveRedactionHits([
      { artifact: "console", class: "credential", action: "redacted", ruleId: "x" },
    ]);
    expect(activeRecording.redactionHits).toHaveLength(0);
  });

  it("appends hits and caps the list at 10000 by dropping the oldest", () => {
    activeRecording.sessionId = "s-1";
    activeRecording.redactionHits = Array.from({ length: 10000 }, (_, i) => ({
      artifact: "console",
      class: "credential",
      action: "redacted",
      ruleId: `old-${i}`,
    }));
    recordActiveRedactionHits([
      { artifact: "console", class: "credential", action: "redacted", ruleId: "new" },
    ]);
    expect(activeRecording.redactionHits).toHaveLength(10000);
    expect(activeRecording.redactionHits.at(-1)?.ruleId).toBe("new");
    expect(activeRecording.redactionHits[0]?.ruleId).toBe("old-1");
  });
});

describe("addActivePrivacyLimitation", () => {
  it("adds a new limitation message once", () => {
    addActivePrivacyLimitation("Storage snapshot was skipped.");
    addActivePrivacyLimitation("Storage snapshot was skipped.");
    expect(activeRecording.privacyLimitations).toEqual(["Storage snapshot was skipped."]);
  });

  it("ignores an empty message", () => {
    addActivePrivacyLimitation("");
    expect(activeRecording.privacyLimitations).toHaveLength(0);
  });
});

describe("session artifacts getter/setter", () => {
  it("round-trips a full replacement", () => {
    setSessionArtifacts({
      "s-1": { duration: 1000, url: "https://example.com", startTime: 0, stopTime: 1000 },
    });
    expect(getSessionArtifacts()["s-1"]?.url).toBe("https://example.com");
  });
});
