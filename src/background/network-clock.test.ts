import { describe, expect, it } from "vitest";
import { monotonicSecondsToEpochMs, wallClockOffsetFromNetworkPair } from "./network-clock";
import { StorageManager } from "./storage-manager";

describe("network clock (CDP monotonic → epoch)", () => {
  it("learns offset from a requestWillBeSent pair", () => {
    // Monotonic 5000s, wall 1_700_000_000s → offset aligns them.
    const offset = wallClockOffsetFromNetworkPair(5000, 1_700_000_000);
    expect(offset).toBe(1_700_000_000_000 - 5_000_000);
    expect(monotonicSecondsToEpochMs(5000, offset)).toBe(1_700_000_000_000);
    expect(monotonicSecondsToEpochMs(5001.5, offset)).toBe(1_700_000_000_000 + 1500);
  });

  it("falls back to nowMs when offset is missing (small monotonic)", () => {
    const now = 1_780_000_000_000;
    expect(monotonicSecondsToEpochMs(12.5, null, now)).toBe(now);
  });

  it("keeps Instant Replay WS frames that are in-window after conversion", () => {
    // Simulates CDP frames: raw monotonic seconds, converted via network offset
    // before StorageManager trim (the real capture path). Use wall-clock ≈ now
    // so finalize's Date.now()-based trim does not drop the fresh frame.
    const nowMs = Date.now();
    const wallNowSec = nowMs / 1000;
    const monoNow = 10_000;
    const offset = wallClockOffsetFromNetworkPair(monoNow, wallNowSec);
    expect(offset).not.toBeNull();

    const manager = new StorageManager();
    manager.beginSession();
    manager.setRollingWindowMs(30_000);

    const oldMono = monoNow - 45; // 45s earlier on monotonic clock
    const freshMono = monoNow - 5;
    const oldEpoch = monotonicSecondsToEpochMs(oldMono, offset!);
    const freshEpoch = monotonicSecondsToEpochMs(freshMono, offset!);

    // Prove conversion preserves monotonic deltas (40s between old and fresh).
    expect(freshEpoch - oldEpoch).toBe(40_000);

    manager.addWebSocketEntry({
      requestId: "ws-cdp",
      url: "wss://example.com/socket",
      closed: false,
      frames: [
        {
          direction: "sent",
          timestamp: oldEpoch,
          opcode: 1,
          payloadData: "old-frame",
        },
        {
          direction: "received",
          timestamp: freshEpoch,
          opcode: 1,
          payloadData: "fresh-frame",
        },
      ],
    });

    const finalized = manager.finalizeCurrentSession();
    expect(finalized.webSocketLogs).toBeTypeOf("string");
    expect(finalized.webSocketLogs).toContain("fresh-frame");
    expect(finalized.webSocketLogs).not.toContain("old-frame");
  });

  it("raw monotonic seconds without conversion would all look ancient vs Date.now", () => {
    // Documents the bug: comparing mono*1000 to Date.now()-window drops everything.
    const monoMs = 10_000 * 1000;
    const now = Date.now();
    expect(monoMs < now - 30_000).toBe(true);
  });
});
