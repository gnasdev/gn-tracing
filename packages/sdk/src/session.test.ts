/**
 * End-to-end test for the SDK: instrument a fake page, stop, then read the
 * package back with the real reader.
 *
 * Asserting through `openRecordingPackage` rather than through the session's
 * own buffers is the point — it is the same code path the player and the MCP
 * server take, so a package this test accepts is one they can open.
 */

import { describe, expect, it, vi } from "vitest";
import { openRecordingPackageFromBytes } from "../../replay-core/src/artifacts";
import type {
  InstantReplayArtifact,
  ScreenshotArtifact,
} from "../../replay-core/src/schema/annotation";
import type {
  ConsoleEntry,
  NetworkEntry,
  RecordingPrivacySummary,
} from "../../replay-core/src/schema/capture";
import { concatChunks } from "../../replay-core/src/write";
import { RecordingSession } from "./session";

/**
 * The smallest window surface the session touches. A real jsdom window would
 * work too, but a hand-built scope makes it obvious which globals the SDK
 * patches — and proves it restores exactly those.
 */
type FakeWindow = Window & {
  console: Console;
  __originalFetch: typeof fetch;
  __emit: (type: string, event: unknown) => void;
  /** Fire every registered interval once, so timer-driven capture is testable. */
  __tickIntervals: () => void;
};

/**
 * A tiny DOM for the screenshot and instant-replay paths. Same reasoning as the
 * core's capture tests: `serializeDomTree` touches a narrow, deliberate slice
 * of the DOM API, and building it by hand keeps that slice visible.
 */
function fakeDocument(): Document {
  const child = {
    nodeType: 1,
    nodeName: "H1",
    tagName: "H1",
    attributes: [] as Array<{ name: string; value: string }>,
    childNodes: [{ nodeType: 3, nodeName: "#text", nodeValue: "Checkout", childNodes: [] }],
    matches: () => false,
    getAttribute: () => null,
  };
  const root = {
    nodeType: 1,
    nodeName: "HTML",
    tagName: "HTML",
    attributes: [] as Array<{ name: string; value: string }>,
    childNodes: [child],
    matches: () => false,
    getAttribute: () => null,
  };
  return { documentElement: root, cookie: "", title: "Checkout" } as unknown as Document;
}

function createFakeWindow(): FakeWindow {
  const listeners = new Map<string, Set<EventListener>>();
  const intervals: Array<() => void> = [];
  const originalFetch = vi.fn(
    async () => new Response('{"ok":true}', { status: 200, headers: { "x-trace": "abc" } }),
  ) as unknown as typeof fetch;

  const scope = {
    console: {
      log: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      trace: () => {},
    },
    fetch: originalFetch,
    localStorage: undefined,
    sessionStorage: undefined,
    performance: { now: () => performance.now() },
    document: fakeDocument(),
    location: { href: "https://shop.test/checkout" },
    history: undefined,
    innerWidth: 390,
    innerHeight: 844,
    devicePixelRatio: 3,
    scrollX: 0,
    scrollY: 0,
    setInterval(handler: () => void) {
      intervals.push(handler);
      return intervals.length;
    },
    clearInterval() {
      intervals.length = 0;
    },
    __tickIntervals() {
      for (const handler of [...intervals]) {
        handler();
      }
    },
    addEventListener(type: string, listener: EventListener) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type: string, listener: EventListener) {
      listeners.get(type)?.delete(listener);
    },
    __listeners: listeners,
    __originalFetch: originalFetch,
    /** Fire a page event at whatever the session registered for it. */
    __emit(type: string, event: unknown) {
      for (const listener of listeners.get(type) ?? []) {
        (listener as unknown as (value: unknown) => void)(event);
      }
    },
  };

  return scope as unknown as FakeWindow;
}

function listenerCount(win: Window): number {
  const listeners = (win as unknown as { __listeners: Map<string, Set<EventListener>> })
    .__listeners;
  let total = 0;
  for (const set of listeners.values()) {
    total += set.size;
  }
  return total;
}

describe("RecordingSession", () => {
  it("writes a package the shared reader can open", async () => {
    const win = createFakeWindow();
    const session = new RecordingSession({ window: win });
    session.start();

    win.console.error("checkout failed", { code: 500 });
    await win.fetch("https://shop.test/api/coupon");

    const result = await session.stop();
    const pkg = await openRecordingPackageFromBytes(concatChunks(result.package.chunks));

    expect(pkg.metadata.producer).toBe("sdk");
    expect(pkg.metadata.capabilities).not.toContain("video");
    expect(pkg.metadata.url).toBe("https://shop.test/checkout");

    const consoleEntries = await pkg.readArtifact<ConsoleEntry[]>("console");
    expect(consoleEntries?.some((entry) => entry.level === "error")).toBe(true);

    const network = await pkg.readArtifact<NetworkEntry[]>("network");
    expect(network?.some((entry) => entry.url.includes("/api/coupon"))).toBe(true);
  });

  it("stores duration in milliseconds", async () => {
    const win = createFakeWindow();
    const session = new RecordingSession({ window: win });
    session.start();

    // Timer wakeups can fire slightly early under load; use a margin so the
    // assertion still distinguishes ms (dozens–hundreds) from seconds (~0.1).
    await new Promise((resolve) => setTimeout(resolve, 120));
    const result = await session.stop();
    const pkg = await openRecordingPackageFromBytes(concatChunks(result.package.chunks));

    expect(pkg.metadata.duration).toBeGreaterThanOrEqual(50);
    expect(pkg.metadata.duration).toBeLessThan(5_000);
    expect(Number.isInteger(pkg.metadata.duration)).toBe(true);
  });

  it("declares what it could not capture instead of leaving it implicit", async () => {
    const win = createFakeWindow();
    const session = new RecordingSession({ window: win });
    session.start();
    const result = await session.stop();

    const pkg = await openRecordingPackageFromBytes(concatChunks(result.package.chunks));
    const privacy = await pkg.readArtifact<RecordingPrivacySummary>("privacy");

    expect(privacy?.artifactFlags.video).toBe(false);
    expect(privacy?.limitations?.join(" ")).toMatch(/no tab video/i);
    expect(privacy?.limitations?.join(" ")).toMatch(/cross-origin/i);

    // No video anywhere in the package, and the reader must not mind.
    expect(pkg.entries.some((entry) => entry.name.startsWith("video."))).toBe(false);
    expect(pkg.hasArtifact("console")).toBe(false);
  });

  it("records uncaught errors and unhandled rejections as exceptions", async () => {
    const win = createFakeWindow();
    const session = new RecordingSession({ window: win });
    session.start();

    win.__emit("error", {
      message: "Cannot read properties of undefined (reading 'total')",
      filename: "https://shop.test/checkout.js",
      lineno: 42,
      colno: 17,
      error: new TypeError("Cannot read properties of undefined (reading 'total')"),
    });
    win.__emit("unhandledrejection", { reason: new Error("coupon service timed out") });

    const result = await session.stop();
    const pkg = await openRecordingPackageFromBytes(concatChunks(result.package.chunks));
    const entries = (await pkg.readArtifact<ConsoleEntry[]>("console")) ?? [];

    const uncaught = entries.find((entry) => entry.source === "exception" && entry.lineNumber);
    expect(uncaught?.message).toContain("reading 'total'");
    expect(uncaught?.url).toBe("https://shop.test/checkout.js");
    expect(uncaught?.lineNumber).toBe(42);

    const rejection = entries.find((entry) => entry.message?.includes("Unhandled promise"));
    expect(rejection?.message).toContain("coupon service timed out");
    expect(rejection?.level).toBe("error");
  });

  it("restores every patched global and listener on stop", async () => {
    const win = createFakeWindow();
    const session = new RecordingSession({ window: win });

    const beforeFetch = win.fetch;
    const beforeListeners = listenerCount(win);

    session.start();
    expect(win.fetch).not.toBe(beforeFetch);
    expect(listenerCount(win)).toBeGreaterThan(beforeListeners);

    await session.stop();
    expect(win.fetch).toBe(beforeFetch);
    expect(win.fetch).toBe(win.__originalFetch);
    expect(listenerCount(win)).toBe(beforeListeners);
  });

  it("drops the oldest entries at the buffer cap and says so", async () => {
    const win = createFakeWindow();
    const session = new RecordingSession({ window: win, limits: { maxConsoleEntries: 3 } });
    session.start();

    for (let index = 0; index < 10; index += 1) {
      win.console.log(`entry-${index}`);
    }

    const result = await session.stop();
    const pkg = await openRecordingPackageFromBytes(concatChunks(result.package.chunks));

    const entries = await pkg.readArtifact<ConsoleEntry[]>("console");
    expect(entries).toHaveLength(3);
    // FIFO: the newest survive.
    expect(entries?.[2]?.message).toContain("entry-9");

    const privacy = await pkg.readArtifact<RecordingPrivacySummary>("privacy");
    expect(privacy?.limitations?.join(" ")).toMatch(/7 oldest console entries were dropped/);
  });

  it("captures an annotated screenshot as a DOM snapshot", async () => {
    const win = createFakeWindow();
    const session = new RecordingSession({ window: win });
    session.start();

    const id = session.captureScreenshot({ caption: "Total is wrong" });
    session.annotateScreenshot(id, [
      {
        id: "a1",
        createdAt: Date.now(),
        type: "arrow",
        from: { x: 0.2, y: 0.2 },
        to: { x: 0.7, y: 0.4 },
      },
      {
        id: "a2",
        createdAt: Date.now(),
        type: "text",
        at: { x: 0.7, y: 0.45 },
        text: "should be $42",
      },
    ]);

    const result = await session.stop();
    const pkg = await openRecordingPackageFromBytes(concatChunks(result.package.chunks));
    const artifact = await pkg.readArtifact<ScreenshotArtifact>("screenshots");

    expect(artifact?.screenshots).toHaveLength(1);
    const shot = artifact?.screenshots[0];
    expect(shot?.caption).toBe("Total is wrong");
    expect(shot?.source).toEqual({ kind: "dom-snapshot", snapshotIndex: 0 });
    expect(shot?.annotations).toHaveLength(2);
    expect(shot?.viewport).toMatchObject({ width: 390, height: 844 });

    // The snapshot the screenshot points at must actually be in the package.
    const dom = await pkg.readArtifact<{ snapshots: unknown[] }>("dom");
    expect(dom?.snapshots).toHaveLength(1);

    // And the package must not claim a raster capability it does not have.
    expect(pkg.metadata.capabilities).not.toContain("screenshot");
    expect(pkg.metadata.capabilities).toContain("annotation");
  });

  it("refuses a pending redaction it has no pixels to destroy", async () => {
    const win = createFakeWindow();
    const session = new RecordingSession({ window: win });
    session.start();
    const id = session.captureScreenshot();

    expect(() =>
      session.annotateScreenshot(id, [
        {
          id: "r1",
          createdAt: Date.now(),
          type: "redact",
          rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.1 },
          applied: "pending",
        },
      ]),
    ).toThrow(/cannot bake a redaction/i);

    await session.stop();
  });

  it("packages the instant replay buffer when it is enabled", async () => {
    const win = createFakeWindow();
    const session = new RecordingSession({
      window: win,
      instantReplay: { intervalMs: 10, windowMs: 30_000 },
    });
    session.start();

    win.__tickIntervals();
    win.__tickIntervals();

    const result = await session.stop();
    const pkg = await openRecordingPackageFromBytes(concatChunks(result.package.chunks));
    const replay = await pkg.readArtifact<InstantReplayArtifact>("instantReplay");

    expect(replay?.frames.length).toBe(2);
    expect(replay?.windowMs).toBe(30_000);
    expect(replay?.frames[0].documentUrl).toBe("https://shop.test/checkout");
  });

  it("writes no instant-replay artifact when the feature is off", async () => {
    const win = createFakeWindow();
    const session = new RecordingSession({ window: win });
    session.start();
    win.__tickIntervals();

    const result = await session.stop();
    const pkg = await openRecordingPackageFromBytes(concatChunks(result.package.chunks));

    expect(pkg.hasArtifact("instantReplay")).toBe(false);
    expect(session.instantReplayStatus.enabled).toBe(false);
  });

  it("refuses to package a session twice", async () => {
    const win = createFakeWindow();
    const session = new RecordingSession({ window: win });
    session.start();
    await session.stop();
    await expect(session.stop()).rejects.toThrow(/already been stopped/);
  });
});
