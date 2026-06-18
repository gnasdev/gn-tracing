/**
 * Unit tests for the shared in-memory Chrome API mock lifecycle.
 *
 * These tests exercise the mock primitives directly (rather than relying on the
 * global `beforeEach`/`afterEach` harness in `test/setup.ts`) so the mock's own
 * contract is verified in isolation:
 *
 * - `createChromeMock` returns a fresh, empty instance (Requirement 4.2).
 * - `installChromeMock` assigns the instance to `globalThis.chrome` (Requirement 4.3).
 * - Spies record arguments, call counts, and cross-spy invocation order (Requirement 4.4).
 * - A freshly installed mock starts isolated, and `resetChromeMock` clears storage
 *   and call counts between tests (Requirements 4.9, 4.10).
 * - Accessing an unmocked `chrome.*` namespace throws an error naming the missing
 *   path (Requirement 4.11).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ChromeMock, createChromeMock, installChromeMock, resetChromeMock } from "./chrome";

describe("createChromeMock", () => {
  it("returns a fresh instance with empty storage areas (Requirement 4.2)", () => {
    const chrome = createChromeMock();

    expect(chrome.storage.session.store).toEqual({});
    expect(chrome.storage.local.store).toEqual({});
  });

  it("returns spies with zero recorded calls (Requirement 4.2)", () => {
    const chrome = createChromeMock();

    expect(chrome.runtime.sendMessage.callCount).toBe(0);
    expect(chrome.runtime.sendMessage.calls).toEqual([]);
    expect(chrome.tabs.query.callCount).toBe(0);
    expect(chrome.storage.local.set.callCount).toBe(0);
    expect(chrome.storage.session.get.calls).toEqual([]);
  });

  it("isolates state between separate instances (Requirement 4.2)", () => {
    const first = createChromeMock();
    first.runtime.sendMessage({ type: "ping" });
    first.storage.local.set({ key: "value" });

    const second = createChromeMock();

    expect(second.runtime.sendMessage.callCount).toBe(0);
    expect(second.storage.local.store).toEqual({});
  });

  it("provides stubs for every required namespace (Requirement 4.1)", () => {
    const chrome = createChromeMock();

    expect(chrome.storage.session).toBeDefined();
    expect(chrome.storage.local).toBeDefined();
    expect(chrome.runtime).toBeDefined();
    expect(chrome.tabs).toBeDefined();
    expect(chrome.alarms).toBeDefined();
    expect(chrome.debugger).toBeDefined();
    expect(chrome.action).toBeDefined();
  });
});

describe("installChromeMock", () => {
  const originalChrome = (globalThis as { chrome?: unknown }).chrome;

  afterEach(() => {
    (globalThis as { chrome?: unknown }).chrome = originalChrome;
  });

  it("assigns the returned mock to globalThis.chrome (Requirement 4.3)", () => {
    const chrome = installChromeMock();

    expect((globalThis as { chrome?: unknown }).chrome).toBe(chrome);
  });

  it("replaces any previously installed mock (Requirement 4.3)", () => {
    const first = installChromeMock();
    const second = installChromeMock();

    expect(second).not.toBe(first);
    expect((globalThis as { chrome?: unknown }).chrome).toBe(second);
  });
});

describe("spy recording (Requirement 4.4)", () => {
  let chrome: ChromeMock;

  beforeEach(() => {
    chrome = createChromeMock();
  });

  it("records the arguments passed to each invocation", () => {
    chrome.runtime.sendMessage({ type: "hello" }, 42);

    expect(chrome.runtime.sendMessage.calls).toHaveLength(1);
    expect(chrome.runtime.sendMessage.calls[0].args).toEqual([{ type: "hello" }, 42]);
  });

  it("increments the recorded call count for each invocation", () => {
    chrome.tabs.query({});
    chrome.tabs.query({ active: true });

    expect(chrome.tabs.query.callCount).toBe(2);
    expect(chrome.tabs.query.calls).toHaveLength(2);
  });

  it("preserves the relative order of invocations across different spies", () => {
    chrome.runtime.sendMessage("first");
    chrome.tabs.create({ url: "https://example.com/" });
    chrome.runtime.sendMessage("third");

    const firstOrder = chrome.runtime.sendMessage.calls[0].order;
    const secondOrder = chrome.tabs.create.calls[0].order;
    const thirdOrder = chrome.runtime.sendMessage.calls[1].order;

    expect(firstOrder).toBe(1);
    expect(secondOrder).toBe(2);
    expect(thirdOrder).toBe(3);
    expect(firstOrder).toBeLessThan(secondOrder);
    expect(secondOrder).toBeLessThan(thirdOrder);
  });
});

describe("per-test reset lifecycle (Requirements 4.9, 4.10)", () => {
  it("installs a fresh, isolated mock (Requirement 4.9)", () => {
    const chrome = installChromeMock();

    expect(chrome.storage.local.store).toEqual({});
    expect(chrome.runtime.sendMessage.callCount).toBe(0);
  });

  it("resetChromeMock clears in-memory storage areas (Requirement 4.10)", async () => {
    const chrome = createChromeMock();
    await chrome.storage.local.set({ key: "value" });
    await chrome.storage.session.set({ other: "thing" });

    resetChromeMock(chrome);

    expect(chrome.storage.local.store).toEqual({});
    expect(chrome.storage.session.store).toEqual({});
    await expect(chrome.storage.local.get("key")).resolves.toEqual({});
  });

  it("resetChromeMock zeroes every spy's recorded call count (Requirement 4.10)", () => {
    const chrome = createChromeMock();
    chrome.runtime.sendMessage("a");
    chrome.tabs.query({});

    resetChromeMock(chrome);

    expect(chrome.runtime.sendMessage.callCount).toBe(0);
    expect(chrome.runtime.sendMessage.calls).toEqual([]);
    expect(chrome.tabs.query.callCount).toBe(0);
  });

  it("resetChromeMock restarts the cross-spy invocation order counter (Requirement 4.10)", () => {
    const chrome = createChromeMock();
    chrome.runtime.sendMessage("a");
    chrome.tabs.create({});

    resetChromeMock(chrome);
    chrome.runtime.sendMessage("b");

    expect(chrome.runtime.sendMessage.calls[0].order).toBe(1);
  });

  it("resetChromeMock targets the installed mock when called with no argument (Requirement 4.10)", () => {
    const chrome = installChromeMock();
    chrome.runtime.sendMessage("a");

    resetChromeMock();

    expect(chrome.runtime.sendMessage.callCount).toBe(0);
  });
});

describe("missing-namespace guard (Requirement 4.11)", () => {
  it("throws naming the missing top-level namespace path", () => {
    const chrome = createChromeMock();

    expect(() => {
      // @ts-expect-error scripting is intentionally not mocked
      void chrome.scripting;
    }).toThrow(/chrome\.scripting/);
  });

  it("throws naming the missing member of an existing namespace", () => {
    const chrome = createChromeMock();

    expect(() => {
      // @ts-expect-error tabs.remove is intentionally not mocked
      void chrome.tabs.remove;
    }).toThrow(/chrome\.tabs\.remove/);
  });

  it("does not throw for defined-but-undefined optional members", () => {
    const chrome = createChromeMock();

    expect(() => chrome.runtime.lastError).not.toThrow();
    expect(chrome.runtime.lastError).toBeUndefined();
  });
});
