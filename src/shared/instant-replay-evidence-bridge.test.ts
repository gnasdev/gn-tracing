/**
 * Bridge helpers used by ISOLATED Instant Replay and service-worker pause/resume.
 */
import { describe, expect, it, vi } from "vitest";
import {
  buildEvidenceControlMessage,
  evidenceBundleHasData,
  IR_EVIDENCE_MESSAGE_TAG,
  mergeEvidenceBundles,
  normalizeEvidenceBundle,
  parseMainWorldEvidenceJson,
  postEvidenceControl,
  requestEvidenceCollect,
  serializeEvidenceBundleForTransport,
} from "./instant-replay-evidence-bridge";

describe("buildEvidenceControlMessage", () => {
  it("builds PAUSE/RESUME payloads the MAIN evidence script accepts", () => {
    const pause = buildEvidenceControlMessage("PAUSE");
    expect(pause[IR_EVIDENCE_MESSAGE_TAG]).toBe(true);
    expect(pause.direction).toBe("control");
    expect(pause.type).toBe("PAUSE");

    const resume = buildEvidenceControlMessage("RESUME");
    expect(resume.type).toBe("RESUME");
    expect(resume[IR_EVIDENCE_MESSAGE_TAG]).toBe(true);
  });
});

describe("normalizeEvidenceBundle / evidenceBundleHasData", () => {
  it("returns null for missing evidence and empty-safe for partial objects", () => {
    expect(normalizeEvidenceBundle(undefined)).toBeNull();
    expect(normalizeEvidenceBundle(null)).toBeNull();
    const empty = normalizeEvidenceBundle({});
    expect(empty).toEqual({
      console: [],
      network: [],
      websocket: [],
      storage: [],
    });
    expect(evidenceBundleHasData(empty)).toBe(false);
    expect(
      evidenceBundleHasData({
        console: [{ source: "console-api", level: "log", timestamp: 1 }],
        network: [],
        websocket: [],
        storage: [],
      }),
    ).toBe(true);
  });
});

describe("requestEvidenceCollect", () => {
  it("resolves the MAIN COLLECT_RESULT bundle for a matching requestId", async () => {
    const listeners = new Set<(event: MessageEvent) => void>();
    const targetWindow = {
      addEventListener: (_type: string, listener: (event: MessageEvent) => void) => {
        listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: (event: MessageEvent) => void) => {
        listeners.delete(listener);
      },
      postMessage: (message: unknown) => {
        const control = message as {
          type?: string;
          requestId?: string;
          direction?: string;
        };
        expect(control.type).toBe("COLLECT");
        expect(control.direction).toBe("control");
        for (const listener of listeners) {
          listener({
            source: targetWindow,
            data: {
              [IR_EVIDENCE_MESSAGE_TAG]: true,
              direction: "result",
              type: "COLLECT_RESULT",
              requestId: control.requestId,
              bundle: {
                console: [{ source: "console-api", level: "log", timestamp: 1, message: "ok" }],
                network: [],
                websocket: [],
                storage: [],
              },
            },
          } as MessageEvent);
        }
      },
    } as unknown as Window;

    const bundle = await requestEvidenceCollect(targetWindow, 500);
    expect(bundle?.console[0]?.message).toBe("ok");
  });

  it("times out to null when MAIN never answers", async () => {
    vi.useFakeTimers();
    const targetWindow = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      postMessage: vi.fn(),
    } as unknown as Window;

    const pending = requestEvidenceCollect(targetWindow, 200);
    await vi.advanceTimersByTimeAsync(250);
    await expect(pending).resolves.toBeNull();
    vi.useRealTimers();
  });
});

describe("postEvidenceControl", () => {
  it("posts a typed control message", () => {
    const postMessage = vi.fn();
    const targetWindow = { postMessage } as unknown as Window;
    postEvidenceControl(targetWindow, "COMMIT");
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        [IR_EVIDENCE_MESSAGE_TAG]: true,
        direction: "control",
        type: "COMMIT",
      }),
      "*",
    );
  });
});

describe("mergeEvidenceBundles / serialize / parseMainWorldEvidenceJson", () => {
  it("merges per kind so storage-only does not hide console", () => {
    const primary = normalizeEvidenceBundle({
      console: [{ source: "console-api", level: "log", timestamp: 1, message: "a" }],
    });
    const fallback = normalizeEvidenceBundle({
      console: [{ source: "console-api", level: "log", timestamp: 2, message: "b" }],
    });
    // Same length → keep primary.
    expect(mergeEvidenceBundles(primary, fallback)?.console[0]?.message).toBe("a");
    expect(mergeEvidenceBundles(normalizeEvidenceBundle({}), fallback)?.console[0]?.message).toBe(
      "b",
    );

    const storageOnly = normalizeEvidenceBundle({
      storage: [
        { phase: "stop", capturedAt: 1, localStorage: [], sessionStorage: [], cookies: [] },
      ],
    });
    const consoleOnly = normalizeEvidenceBundle({
      console: [{ source: "console-api", level: "error", timestamp: 3, message: "bug" }],
    });
    const merged = mergeEvidenceBundles(storageOnly, consoleOnly);
    expect(merged?.console[0]?.message).toBe("bug");
    expect(merged?.storage).toHaveLength(1);
  });

  it("JSON-roundtrips a bundle for postMessage safety", () => {
    const bundle = normalizeEvidenceBundle({
      console: [{ source: "console-api", level: "error", timestamp: 9, message: "x" }],
      network: [],
      websocket: [],
      storage: [],
    });
    const serialized = serializeEvidenceBundleForTransport(bundle);
    expect(serialized?.console[0]?.message).toBe("x");
    // Plain object (no prototype tricks) after JSON round-trip.
    expect(Object.getPrototypeOf(serialized)).toBe(Object.prototype);
  });

  it("parses MAIN executeScript JSON strings", () => {
    const parsed = parseMainWorldEvidenceJson(
      JSON.stringify({
        console: [{ source: "console-api", level: "log", timestamp: 1, message: "ok" }],
        network: [],
        websocket: [],
        storage: [],
      }),
    );
    expect(parsed?.console[0]?.message).toBe("ok");
    expect(parseMainWorldEvidenceJson(null)).toBeNull();
    expect(parseMainWorldEvidenceJson("nope")).toBeNull();
  });
});
