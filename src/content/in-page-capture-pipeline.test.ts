/**
 * End-to-end integration test for the in-page capture pipeline.
 *
 * Almost every other test in this repo asserts on *source text* (does the file
 * contain this string?), which is why a fully broken feature can still report
 * hundreds of green tests: grepping source cannot observe runtime behaviour. This
 * test instead loads the REAL production modules and wires them the way the two
 * browser worlds are wired, then asserts on the payloads that actually reach
 * `chrome.runtime.sendMessage`. It must FAIL if the pipeline is broken and pass
 * only when entries genuinely flow MAIN -> bridge -> service worker.
 *
 * Topology mirrored here (single shared page `window`, exactly as in a real tab):
 *   FirefoxRecordingRuntime --chrome.tabs.sendMessage--> bridge (ISOLATED world,
 *   listens on chrome.runtime.onMessage) --window.postMessage--> MAIN world
 *   (patches console/fetch/...) --window.postMessage(entry)--> bridge
 *   --chrome.runtime.sendMessage--> service worker.
 *
 * Nothing here re-implements capture: `installInPageCapture` runs for real inside
 * the MAIN module, and the bridge's real onMessage/onmessage handlers do the
 * forwarding. Only the environment (window double, chrome mock, fetch double) is
 * synthetic — the wiring under test is production code.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { InPageCaptureKind } from "../../packages/replay-core/src/capture/in-page-capture";
import type {
  ConsoleEntry,
  NetworkEntry,
  StorageSnapshot,
  WebSocketEntry,
} from "../../packages/replay-core/src/schema/capture";
import { installChromeMock } from "../../test/mocks/chrome";
import {
  IN_PAGE_CAPTURE_ENTRY_ACTION,
  type InPageCaptureBridgeMessage,
  isInPageCaptureBridgeMessage,
  isInPageCaptureStopComplete,
} from "../shared/in-page-capture-bridge";

/** The stable tab id used for every tabs.sendMessage delivery in this file. */
const TAB_ID = 42;
/** Session id the START control message carries; asserted on every delivery. */
const SESSION_ID = "sess-integration-1";

/** Shape the bridge forwards to the service worker for each captured entry. */
interface EntryDelivery {
  action: typeof IN_PAGE_CAPTURE_ENTRY_ACTION;
  sessionId: string;
  kind: InPageCaptureKind;
  entry: ConsoleEntry | NetworkEntry | WebSocketEntry | StorageSnapshot;
}

/** A message listener registered on the fake page window. */
type MessageListener = (event: { data: unknown; source: unknown }) => void;

/**
 * A minimal, hand-rolled page-window double. package.json ships neither jsdom
 * nor happy-dom (and this task forbids adding dependencies), so we build only
 * the surface the two capture modules touch: message add/remove/postMessage, a
 * console with the six patched methods, and the globals `installInPageCapture`
 * reads through its injected scope (fetch/document/location/performance).
 */
interface FakeWindow {
  console: Record<string, (...args: unknown[]) => void>;
  performance: { now(): number };
  document: { cookie: string };
  location: { href: string };
  fetch: (input: unknown, init?: unknown) => Promise<unknown>;
  addEventListener(type: string, listener: MessageListener): void;
  removeEventListener(type: string, listener: MessageListener): void;
  postMessage(data: unknown, targetOrigin?: string): void;
  // Capture modules stash their re-entrancy guards and cleanup handle here.
  [key: string]: unknown;
}

/** A no-op console whose six methods are real, distinct, replaceable functions. */
function createFakeConsole(): Record<string, (...args: unknown[]) => void> {
  const noop = (): void => {};
  return { log: noop, info: noop, warn: noop, error: noop, debug: noop, trace: noop };
}

/**
 * A fetch double that resolves to a Response-like object exposing only what the
 * capture reads (`status`, `statusText`, `headers.get`, `headers.forEach`). It
 * never touches the network, so a network *entry* appearing downstream can only
 * come from the real patched fetch, not from this stub.
 */
function createFakeFetch(): (input: unknown, init?: unknown) => Promise<unknown> {
  return () =>
    Promise.resolve({
      status: 200,
      statusText: "OK",
      headers: {
        get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
        forEach: (callback: (value: string, key: string) => void) => {
          callback("application/json", "content-type");
        },
      },
    });
}

/**
 * Build the shared window double. In a real tab the MAIN world and the ISOLATED
 * content script are separate JS realms but share ONE DOM window for
 * postMessage, so both modules must register on and post to the same object
 * here. `postMessage` dispatches synchronously and sets `event.source` to this
 * same window: both modules early-return on `event.source !== window`, and the
 * stop protocol is explicitly written to tolerate a synchronous MAIN ("post
 * after subscribe so a synchronous MAIN cannot race").
 */
function createFakeWindow(): { fakeWindow: FakeWindow; posted: InPageCaptureBridgeMessage[] } {
  const listeners = new Set<MessageListener>();
  const posted: InPageCaptureBridgeMessage[] = [];

  const fakeWindow: FakeWindow = {
    console: createFakeConsole(),
    performance: { now: () => 0 },
    document: { cookie: "" },
    location: { href: "https://page.test/" },
    fetch: createFakeFetch(),
    addEventListener(type, listener) {
      if (type === "message") {
        listeners.add(listener);
      }
    },
    removeEventListener(type, listener) {
      if (type === "message") {
        listeners.delete(listener);
      }
    },
    postMessage(data) {
      if (isInPageCaptureBridgeMessage(data)) {
        posted.push(data);
      }
      // Copy before iterating: the stop drain (un)subscribes a listener mid
      // dispatch, which would otherwise mutate the set we are walking.
      for (const listener of [...listeners]) {
        listener({ data, source: fakeWindow });
      }
    },
  };

  return { fakeWindow, posted };
}

type Chrome = ReturnType<typeof installChromeMock>;

/**
 * Route `chrome.tabs.sendMessage` to the bridge's `chrome.runtime.onMessage`
 * listeners with MV3 promise semantics: a listener returning `true` keeps the
 * channel open until it calls `sendResponse`, and the returned promise resolves
 * with that response. This is how a real content script receives a message the
 * service worker sent — the bare mock spy does not route on its own.
 */
function wireTabsToRuntime(chromeMock: Chrome): void {
  const sender = {} as chrome.runtime.MessageSender;
  chromeMock.tabs.sendMessage.mockImplementation((...args: unknown[]) => {
    const message = args[1];
    return new Promise((resolve) => {
      let responded = false;
      let keepOpen = false;
      const sendResponse = (response?: unknown): void => {
        responded = true;
        resolve(response);
      };
      for (const listener of chromeMock.runtime.onMessage.listeners) {
        if (listener(message, sender, sendResponse) === true) {
          keepOpen = true;
        }
      }
      if (!keepOpen && !responded) {
        resolve(undefined);
      }
    });
  });
}

interface Pipeline {
  chromeMock: Chrome;
  fakeWindow: FakeWindow;
  posted: InPageCaptureBridgeMessage[];
  /** console.error's reference captured before START (to detect patch/restore). */
  originalConsoleError: (...args: unknown[]) => void;
  /** Deliver START exactly as FirefoxRecordingRuntime does. */
  start(): Promise<unknown>;
  /** Deliver STOP exactly as FirefoxRecordingRuntime does; resolves after drain. */
  stop(): Promise<unknown>;
  /** Every entry the bridge forwarded to the service worker, in order. */
  deliveries(): EntryDelivery[];
}

/**
 * Install the environment, then load the REAL modules so their top-level IIFEs
 * register handlers on THIS window/chrome. Globals must exist before import
 * (the IIFEs run at module-eval time), and `vi.resetModules()` forces a fresh
 * evaluation each test so the handlers bind to the current fake window.
 */
async function setupPipeline(): Promise<Pipeline> {
  const chromeMock = installChromeMock();
  // The bridge guards delivery on `chrome.runtime.id`; without it every entry is
  // silently dropped. Define it as a real own property on the mock runtime.
  (chromeMock.runtime as unknown as { id: string }).id = "gn-tracing-integration";
  // The bridge does `sendMessage(...).catch(...)`; the default spy returns
  // undefined, which has no `.catch`. A resolved promise mirrors a live SW.
  chromeMock.runtime.sendMessage.mockImplementation(() => Promise.resolve(undefined));
  wireTabsToRuntime(chromeMock);

  const { fakeWindow, posted } = createFakeWindow();
  (globalThis as { window?: unknown }).window = fakeWindow;

  vi.resetModules();
  await import("./in-page-capture-main");
  await import("./in-page-capture-bridge");

  const originalConsoleError = fakeWindow.console.error;

  return {
    chromeMock,
    fakeWindow,
    posted,
    originalConsoleError,
    start: () =>
      chromeMock.tabs.sendMessage(TAB_ID, {
        target: "in-page-capture",
        type: "START",
        sessionId: SESSION_ID,
      }) as Promise<unknown>,
    stop: () =>
      chromeMock.tabs.sendMessage(TAB_ID, {
        target: "in-page-capture",
        type: "STOP",
      }) as Promise<unknown>,
    deliveries: () =>
      chromeMock.runtime.sendMessage.calls
        .map((call) => call.args[0])
        .filter(
          (payload): payload is EntryDelivery =>
            !!payload &&
            typeof payload === "object" &&
            (payload as { action?: unknown }).action === IN_PAGE_CAPTURE_ENTRY_ACTION,
        ),
  };
}

afterEach(() => {
  // Drop the window double so a leaked reference cannot bleed into the next test,
  // and reset the module registry so the next setup re-evaluates the IIFEs.
  (globalThis as { window?: unknown }).window = undefined;
  vi.resetModules();
  vi.useRealTimers();
});

describe("in-page capture pipeline (MAIN -> bridge -> service worker)", () => {
  it("begins patching the MAIN world when the START control message arrives", async () => {
    const pipeline = await setupPipeline();

    await pipeline.start();

    // MAIN records its cleanup handle only after installInPageCapture ran.
    expect(typeof pipeline.fakeWindow.__gnTracingInPageCaptureCleanup).toBe("function");
    // console.error was actually monkey-patched (reference changed).
    expect(pipeline.fakeWindow.console.error).not.toBe(pipeline.originalConsoleError);
    // The start-phase storage snapshot proves the capture installed and its
    // very first emission crossed MAIN -> bridge -> SW with the right session.
    const startSnapshot = pipeline.deliveries().find((delivery) => delivery.kind === "storage");
    expect(startSnapshot).toBeDefined();
    expect(startSnapshot?.sessionId).toBe(SESSION_ID);
    expect((startSnapshot?.entry as StorageSnapshot).phase).toBe("start");
  });

  it("delivers a page console.error to the service worker as a console entry", async () => {
    const pipeline = await setupPipeline();
    await pipeline.start();

    pipeline.fakeWindow.console.error("boom");

    const consoleEntries = pipeline.deliveries().filter((delivery) => delivery.kind === "console");
    // Exactly the one we produced (start emits storage, not console).
    const boom = consoleEntries.find(
      (delivery) => (delivery.entry as ConsoleEntry).message === "boom",
    );
    expect(boom).toBeDefined();
    expect(boom?.sessionId).toBe(SESSION_ID);
    expect(boom?.action).toBe(IN_PAGE_CAPTURE_ENTRY_ACTION);
    const entry = boom?.entry as ConsoleEntry;
    expect(entry.source).toBe("console-api");
    expect(entry.level).toBe("error");
  });

  it("delivers a page fetch to the service worker as a network entry", async () => {
    const pipeline = await setupPipeline();
    await pipeline.start();

    // The real patched fetch settles the entry only after its inner await, so
    // awaiting the call guarantees the network delivery has been forwarded.
    await pipeline.fakeWindow.fetch("https://api.example.com/data");

    const networkEntry = pipeline.deliveries().find((delivery) => delivery.kind === "network");
    expect(networkEntry).toBeDefined();
    expect(networkEntry?.sessionId).toBe(SESSION_ID);
    const entry = networkEntry?.entry as NetworkEntry;
    expect(entry.url).toBe("https://api.example.com/data");
    expect(entry.method).toBe("GET");
    expect(entry.status).toBe(200);
  });

  it("produces STOP_COMPLETE and stops leaking entries after STOP", async () => {
    const pipeline = await setupPipeline();
    await pipeline.start();
    pipeline.fakeWindow.console.error("before-stop");

    await pipeline.stop();

    // The bridge must have received MAIN's STOP_COMPLETE ack for its drain.
    const stopComplete = pipeline.posted.find((message) => isInPageCaptureStopComplete(message));
    expect(stopComplete).toBeDefined();
    // Cleanup restored console.error to the exact original reference (P6 / R9.4).
    expect(pipeline.fakeWindow.console.error).toBe(pipeline.originalConsoleError);

    // Anything the page does after STOP must NOT reach the service worker.
    const deliveredAfterStop = pipeline.deliveries().length;
    pipeline.fakeWindow.console.error("after-stop");
    await pipeline.fakeWindow.fetch("https://api.example.com/leak");
    expect(pipeline.deliveries().length).toBe(deliveredAfterStop);
  });
});
