/**
 * In-page beginSession must recover when the bridge dies during the arm window.
 *
 * After attach prepares scripts, the user can sit on the share picker for up to
 * ~180s. A navigation (or content-script unload) in that window leaves #prepared
 * true while sendMessage throws "Receiving end does not exist". beginSession must
 * re-inject + START rather than throwing and discarding a committed media session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installChromeMock, resetChromeMock } from "../../../test/mocks/chrome";
import { InPageEvidenceCollector } from "./in-page-collector";

type ExecuteScriptFn = (details: unknown) => Promise<unknown>;

function stubExecuteScript(impl: ExecuteScriptFn) {
  const executeScript = vi.fn(impl);
  vi.stubGlobal("chrome", {
    ...((globalThis.chrome as object) ?? {}),
    scripting: { executeScript },
    tabs: {
      ...(globalThis.chrome as { tabs?: object })?.tabs,
      sendMessage: (globalThis.chrome as { tabs: { sendMessage: unknown } }).tabs.sendMessage,
    },
  });
  return executeScript;
}

describe("InPageEvidenceCollector.beginSession re-arm", () => {
  beforeEach(() => {
    resetChromeMock(installChromeMock());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("re-injects and START when the first START fails after prepare", async () => {
    const executeScript = stubExecuteScript(async () => [{ frameId: 0 }]);
    let startCount = 0;

    const sendMessage = vi.fn(async (_tabId: number, message: { type?: string }) => {
      if (message.type === "VERIFY_REALM") {
        return { ok: true };
      }
      if (message.type === "START") {
        startCount += 1;
        if (startCount === 1) {
          throw new Error("Could not establish connection. Receiving end does not exist.");
        }
        return { ok: true };
      }
      return { ok: true };
    });

    vi.stubGlobal("chrome", {
      scripting: { executeScript },
      tabs: { sendMessage },
    });

    const collector = new InPageEvidenceCollector();
    const attach = await collector.attach({ tabId: 9, sessionId: "s1" });
    expect(attach.ok).toBe(true);

    const armed = await collector.beginSession({ tabId: 9, sessionId: "s1" });
    expect(armed.limitations).toEqual([]);
    expect(startCount).toBeGreaterThanOrEqual(2);
    expect(executeScript.mock.calls.length).toBeGreaterThanOrEqual(4); // 2 worlds × attach + recovery

    const startPayloads = sendMessage.mock.calls
      .map((call) => call[1] as { type?: string; captureNetwork?: boolean })
      .filter((msg) => msg.type === "START");
    expect(startPayloads.length).toBeGreaterThanOrEqual(2);
    for (const start of startPayloads) {
      expect(start.captureNetwork).toBe(false);
    }
  });

  it("returns a limitation instead of throwing when re-inject also fails", async () => {
    let injectPhase: "attach" | "recovery" = "attach";
    const executeScript = stubExecuteScript(async () => {
      if (injectPhase === "attach") {
        return [{ frameId: 0 }];
      }
      return [];
    });

    const sendMessage = vi.fn(async (_tabId: number, message: { type?: string }) => {
      if (message.type === "VERIFY_REALM") {
        return { ok: true };
      }
      if (message.type === "START") {
        throw new Error("Receiving end does not exist");
      }
      return { ok: true };
    });

    vi.stubGlobal("chrome", {
      scripting: { executeScript },
      tabs: { sendMessage },
    });

    const collector = new InPageEvidenceCollector();
    const attach = await collector.attach({ tabId: 3, sessionId: "s2" });
    expect(attach.ok).toBe(true);

    injectPhase = "recovery";
    const armed = await collector.beginSession({ tabId: 3, sessionId: "s2" });
    expect(armed.limitations.length).toBeGreaterThan(0);
    expect(armed.limitations[0]).toMatch(/console|In-page|inject|frame|Grant GN Tracing/i);
  });
});

describe("InPageEvidenceCollector selected surfaces", () => {
  beforeEach(() => {
    resetChromeMock(installChromeMock());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not enable fetch/XHR patches when network was assigned elsewhere", async () => {
    const executeScript = stubExecuteScript(async () => [{ frameId: 0 }]);
    const sendMessage = vi.fn(async (_tabId: number, message: { type?: string }) =>
      message.type === "VERIFY_REALM" ? { ok: true } : { ok: true },
    );
    vi.stubGlobal("chrome", {
      scripting: { executeScript },
      tabs: { sendMessage },
    });

    const collector = new InPageEvidenceCollector({ captureNetwork: true });
    const selectedOffers = [
      { source: "in-page" as const, surface: "console-api" as const, quality: "full" as const },
    ];
    await collector.attach({ tabId: 9, sessionId: "s1", selectedOffers });
    await collector.beginSession({ tabId: 9, sessionId: "s1", selectedOffers });

    const start = sendMessage.mock.calls
      .map((call) => call[1] as { type?: string; captureNetwork?: boolean })
      .find((message) => message.type === "START");
    expect(start?.captureNetwork).toBe(false);
  });
});
