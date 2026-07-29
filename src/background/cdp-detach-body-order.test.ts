/**
 * Structural + behavioral proof that CdpManager.detach drains body fetches
 * before chrome.debugger.detach (via the shared drainBodyFetchesThenDetach helper).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { drainBodyFetchesThenDetach } from "../shared/network-response-body";

const cdpSource = readFileSync(resolve(import.meta.dirname, "cdp-manager.ts"), "utf8");

describe("CdpManager detach body-fetch order (shipped wiring)", () => {
  it("imports and calls drainBodyFetchesThenDetach in detach()", () => {
    expect(cdpSource).toMatch(/import\s*\{[^}]*drainBodyFetchesThenDetach/);
    expect(cdpSource).toMatch(/await\s+drainBodyFetchesThenDetach\s*\(/);
  });

  it("does not call chrome.debugger.detach before the drain helper", () => {
    const detachMethod = cdpSource.match(/async detach\(\)[\s\S]*?\n {2}[a-z#]/);
    expect(detachMethod).toBeTruthy();
    const body = detachMethod?.[0] ?? "";
    expect(body.length).toBeGreaterThan(0);
    const drainIdx = body.indexOf("drainBodyFetchesThenDetach");
    const bareDetachIdx = body.search(/chrome\.debugger\.detach/);
    // The only chrome.debugger.detach inside detach() must live inside the
    // detachDebugger callback passed to the drain helper (after body fetches).
    expect(drainIdx).toBeGreaterThanOrEqual(0);
    expect(bareDetachIdx).toBeGreaterThan(drainIdx);
  });

  it("shared drain helper used by CdpManager keeps detach after body settle", async () => {
    // Drive the exact production helper CdpManager.detach awaits.
    const order: string[] = [];
    let release: (() => void) | undefined;
    const fetchPromise = new Promise<void>((r) => {
      release = r;
    });

    const detachDebugger = vi.fn(async () => {
      order.push("detach");
    });

    const pending = drainBodyFetchesThenDetach({
      bodyFetches: [
        fetchPromise.then(() => {
          order.push("body");
        }),
      ],
      finalizePending: () => order.push("finalize"),
      detachDebugger,
    });

    await Promise.resolve();
    expect(detachDebugger).not.toHaveBeenCalled();
    expect(release).toBeTypeOf("function");
    release?.();
    await pending;
    expect(order).toEqual(["body", "finalize", "detach"]);
  });
});
