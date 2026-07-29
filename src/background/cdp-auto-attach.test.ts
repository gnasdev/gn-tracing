/**
 * Structural proof that child targets pause until Network is enabled.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const cdpSource = readFileSync(resolve(import.meta.dirname, "cdp-manager.ts"), "utf8");

describe("CdpManager auto-attach waitForDebuggerOnStart", () => {
  it("enables waitForDebuggerOnStart so early child requests are not missed", () => {
    expect(cdpSource).toMatch(/waitForDebuggerOnStart:\s*true/);
  });

  it("resumes waiting debugger in a finally block after domain enable", () => {
    const attached = cdpSource.match(/async #onAttachedToTarget[\s\S]*?#onDetachedFromTarget/);
    const body = attached?.[0] ?? "";
    expect(body).toMatch(/finally\s*\{/);
    expect(body).toMatch(/Runtime\.runIfWaitingForDebugger/);
    expect(body).toMatch(/waitingForDebugger/);
  });
});
