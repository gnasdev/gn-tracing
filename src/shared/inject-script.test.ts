/**
 * A resolved executeScript is not proof the script ran.
 *
 * MDN, scripting.executeScript(): "In Firefox and Safari, partial lack of host
 * permissions can result in a successful execution (with the partial results in
 * the resolved promise)." The recording paths used to discard the resolved array,
 * so an injection that never ran looked like success and the recording shipped
 * with empty console/network evidence.
 */

import { describe, expect, it, vi } from "vitest";
import { injectScriptFile, summarizeInjectionResults } from "./inject-script";

describe("summarizeInjectionResults", () => {
  it("treats a frame that ran as success", () => {
    expect(summarizeInjectionResults([{ frameId: 0, result: undefined }])).toEqual({ ok: true });
  });

  it("fails when a frame carries an error object", () => {
    const outcome = summarizeInjectionResults([
      { frameId: 0, error: { message: "Missing host permission for the tab" } },
    ]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain("Missing host permission for the tab");
      expect(outcome.error).toContain("frame 0");
    }
  });

  it("accepts a bare string error", () => {
    const outcome = summarizeInjectionResults([{ error: "blocked" }]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain("blocked");
    }
  });

  it("fails on an empty array — nothing was injected", () => {
    expect(summarizeInjectionResults([])).toEqual({
      ok: false,
      error: "no frame was injected",
    });
  });

  it("reports every failing frame", () => {
    const outcome = summarizeInjectionResults([
      { frameId: 0, result: 1 },
      { frameId: 3, error: { message: "denied" } },
      { frameId: 7, error: { message: "also denied" } },
    ]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toContain("frame 3");
      expect(outcome.error).toContain("frame 7");
    }
  });

  it("does not invent a failure when the engine resolves with undefined", () => {
    expect(summarizeInjectionResults(undefined)).toEqual({ ok: true });
  });
});

describe("multi-frame injection tolerance", () => {
  /**
   * Cross-origin and sandboxed iframes routinely refuse injection. Losing one
   * iframe must degrade the evidence, not abort the whole recording — but the
   * refusal still has to be reported so the replay can say the evidence is
   * incomplete instead of implying the frame was silent.
   */
  it("succeeds when at least one frame took the script", () => {
    const outcome = summarizeInjectionResults(
      [
        { frameId: 0, result: undefined },
        { frameId: 12, error: { message: "Frame not found" } },
      ],
      { requireAllFrames: false },
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.partialFailures).toHaveLength(1);
      expect(outcome.partialFailures?.[0]).toContain("frame 12");
    }
  });

  it("still fails when every frame refused", () => {
    const outcome = summarizeInjectionResults(
      [
        { frameId: 0, error: { message: "denied" } },
        { frameId: 12, error: { message: "denied" } },
      ],
      { requireAllFrames: false },
    );
    expect(outcome.ok).toBe(false);
  });

  it("keeps the strict default for single-frame injection", () => {
    // Without allFrames a single refusal IS total failure, so the default must
    // not silently inherit the tolerant behaviour.
    const outcome = summarizeInjectionResults([
      { frameId: 0, result: 1 },
      { frameId: 12, error: { message: "denied" } },
    ]);
    expect(outcome.ok).toBe(false);
  });

  it("passes allFrames through to the target and tolerates partial failure", async () => {
    const executeScript = vi.fn(async () => [
      { frameId: 0 },
      { frameId: 9, error: { message: "denied" } },
    ]);
    (globalThis.chrome as unknown as { scripting: { executeScript: unknown } }).scripting = {
      executeScript,
    };

    const outcome = await injectScriptFile({
      tabId: 5,
      file: "content/x.js",
      world: "MAIN",
      allFrames: true,
    });

    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 5, allFrames: true },
      files: ["content/x.js"],
      world: "MAIN",
    });
    expect(outcome.ok).toBe(true);
  });
});

describe("injectScriptFile", () => {
  function stubExecuteScript(impl: () => unknown) {
    const executeScript = vi.fn(impl);
    (globalThis.chrome as unknown as { scripting: { executeScript: unknown } }).scripting = {
      executeScript,
    };
    return executeScript;
  }

  it("passes the world through and reports success", async () => {
    const executeScript = stubExecuteScript(async () => [{ frameId: 0 }]);
    await expect(
      injectScriptFile({ tabId: 5, file: "content/main.js", world: "MAIN" }),
    ).resolves.toEqual({ ok: true });
    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 5 },
      files: ["content/main.js"],
      world: "MAIN",
    });
  });

  it("omits world when not requested", async () => {
    const executeScript = stubExecuteScript(async () => [{ frameId: 0 }]);
    await injectScriptFile({ tabId: 5, file: "content/x.js" });
    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 5 },
      files: ["content/x.js"],
    });
  });

  it("surfaces the Firefox resolved-with-error case", async () => {
    stubExecuteScript(async () => [{ frameId: 0, error: { message: "Missing host permission" } }]);
    const outcome = await injectScriptFile({ tabId: 5, file: "content/x.js" });
    expect(outcome.ok).toBe(false);
  });

  it("turns a rejection into the same outcome shape", async () => {
    stubExecuteScript(() => {
      throw new Error("Missing host permission for the tab");
    });
    const outcome = await injectScriptFile({ tabId: 5, file: "content/x.js" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBe("Missing host permission for the tab");
    }
  });
});
