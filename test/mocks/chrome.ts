/**
 * Shared in-memory mock of the `chrome.*` extension APIs used by GN Tracing.
 *
 * This module is intentionally self-contained: it implements its own lightweight
 * spy primitive (rather than depending on a test runner's mock helper) so the
 * mock can be reasoned about and unit-tested in isolation. Each spy records the
 * arguments it was called with, its call count, and a monotonically increasing
 * invocation order shared across every spy in a single mock instance, so that
 * orchestration behaviour spanning multiple namespaces can be asserted.
 *
 * Storage areas (`chrome.storage.session` / `chrome.storage.local`) are backed
 * by an in-memory map so reads observe prior writes within a test. Accessing a
 * `chrome.*` namespace that is not mocked throws an error naming the missing
 * path, turning silent `undefined`-access bugs into actionable failures.
 */

/** A single recorded invocation of a {@link MockSpy}. */
export interface MockSpyCall<Args extends unknown[] = unknown[]> {
  /** The arguments passed to this invocation. */
  args: Args;
  /**
   * The cross-spy invocation order for this call within the owning mock
   * instance. Starts at 1 and increases for every spy call, so the relative
   * order of invocations across different spies can be compared.
   */
  order: number;
}

/**
 * A callable spy that records its invocations. Replaces a test-runner mock so
 * this module has no external dependency, while still supporting the assertions
 * the design requires (arguments, call counts, and cross-spy ordering).
 */
export interface MockSpy<Args extends unknown[] = unknown[], Return = unknown> {
  (...args: Args): Return;
  /** Every recorded invocation, in the order it occurred. */
  calls: Array<MockSpyCall<Args>>;
  /** The number of times this spy has been invoked. */
  callCount: number;
  /** The return value produced by each invocation, in order. */
  results: Return[];
  /** Replace the spy's backing implementation. Returns the spy for chaining. */
  mockImplementation(fn: (...args: Args) => Return): MockSpy<Args, Return>;
  /** Make the spy return a fixed value. Returns the spy for chaining. */
  mockReturnValue(value: Return): MockSpy<Args, Return>;
  /** Clear recorded calls, count, and results without removing the implementation. */
  mockReset(): void;
}

/** An in-memory stand-in for a `chrome.events.Event` listener registry. */
export interface MockEvent<
  Listener extends (...args: never[]) => unknown = (...args: never[]) => unknown,
> {
  addListener: MockSpy<[Listener], void>;
  removeListener: MockSpy<[Listener], void>;
  hasListener: MockSpy<[Listener], boolean>;
  /** Currently registered listeners. */
  listeners: Listener[];
  /** Synchronously invoke every registered listener with the given arguments. */
  emit(...args: Parameters<Listener>): void;
}

/** In-memory implementation of a `chrome.storage` area. */
export interface MockStorageArea {
  get: MockSpy<
    [(string | string[] | Record<string, unknown> | null)?],
    Promise<Record<string, unknown>>
  >;
  set: MockSpy<[Record<string, unknown>], Promise<void>>;
  remove: MockSpy<[string | string[]], Promise<void>>;
  clear: MockSpy<[], Promise<void>>;
  onChanged: MockEvent;
  /** Direct, synchronous access to the backing store for test assertions. */
  readonly store: Record<string, unknown>;
}

/** The shape of the mocked `chrome` global. */
export interface ChromeMock {
  storage: {
    session: MockStorageArea;
    local: MockStorageArea;
  };
  runtime: {
    sendMessage: MockSpy;
    onMessage: MockEvent;
    getURL: MockSpy<[string], string>;
    lastError: { message: string } | undefined;
  };
  tabs: {
    query: MockSpy;
    get: MockSpy;
    create: MockSpy;
    sendMessage: MockSpy;
  };
  alarms: {
    create: MockSpy;
    clear: MockSpy;
  };
  debugger: {
    attach: MockSpy;
    detach: MockSpy;
    sendCommand: MockSpy;
    onEvent: MockEvent;
  };
  action: {
    setBadgeText: MockSpy;
    setBadgeBackgroundColor: MockSpy;
  };
}

/** Mutable counter shared by every spy in one mock instance to order calls. */
interface InvocationOrderCounter {
  value: number;
}

/** Minimal surface needed to bulk-reset spies, independent of their signatures. */
interface Resettable {
  mockReset(): void;
}

/** Internal bookkeeping kept alongside an exposed {@link ChromeMock}. */
interface InternalMock {
  chrome: ChromeMock;
  counter: InvocationOrderCounter;
  spies: Resettable[];
  storageAreas: MockStorageArea[];
  events: MockEvent[];
}

/** Symbol used to stash {@link InternalMock} on a guarded mock without exposing it. */
const INTERNAL = Symbol("gn-tracing.chromeMock.internal");

/** The mock most recently installed onto `globalThis.chrome`, if any. */
let installedMock: InternalMock | null = null;

/**
 * Create a recording spy bound to a shared invocation-order counter.
 *
 * @param counter The per-instance counter incremented on every spy call.
 * @param registry Collection the new spy is registered into for bulk reset.
 * @param impl Optional backing implementation invoked with the call arguments.
 */
function createSpy<Args extends unknown[] = unknown[], Return = unknown>(
  counter: InvocationOrderCounter,
  registry: Resettable[],
  impl?: (...args: Args) => Return,
): MockSpy<Args, Return> {
  let implementation: ((...args: Args) => Return) | undefined = impl;

  const spy = ((...args: Args): Return => {
    counter.value += 1;
    spy.calls.push({ args, order: counter.value });
    spy.callCount = spy.calls.length;
    const result = (implementation ? implementation(...args) : undefined) as Return;
    spy.results.push(result);
    return result;
  }) as MockSpy<Args, Return>;

  spy.calls = [];
  spy.callCount = 0;
  spy.results = [];
  spy.mockImplementation = (fn) => {
    implementation = fn;
    return spy;
  };
  spy.mockReturnValue = (value) => {
    implementation = () => value;
    return spy;
  };
  spy.mockReset = () => {
    spy.calls = [];
    spy.callCount = 0;
    spy.results = [];
  };

  registry.push(spy);
  return spy;
}

/** Create a listener-registry event stub backed by recording spies. */
function createEvent(
  counter: InvocationOrderCounter,
  registry: Resettable[],
  events: MockEvent[],
): MockEvent {
  const listeners: Array<(...args: never[]) => unknown> = [];

  const event: MockEvent = {
    addListener: createSpy<[(...args: never[]) => unknown], void>(counter, registry, (listener) => {
      if (!listeners.includes(listener)) {
        listeners.push(listener);
      }
    }),
    removeListener: createSpy<[(...args: never[]) => unknown], void>(
      counter,
      registry,
      (listener) => {
        const index = listeners.indexOf(listener);
        if (index !== -1) {
          listeners.splice(index, 1);
        }
      },
    ),
    hasListener: createSpy<[(...args: never[]) => unknown], boolean>(
      counter,
      registry,
      (listener) => listeners.includes(listener),
    ),
    listeners,
    emit: (...args) => {
      for (const listener of [...listeners]) {
        (listener as (...a: unknown[]) => unknown)(...args);
      }
    },
  };

  events.push(event);
  return event;
}

/**
 * Assign an own enumerable data property, safe for hazardous keys.
 *
 * A plain `target[key] = value` assignment invokes `[[Set]]`, which for the key
 * `"__proto__"` triggers the prototype setter on `Object.prototype` instead of
 * creating an own property. Storage keys are arbitrary strings, so we define the
 * property directly to guarantee a real, readable own key for any string.
 */
function assignOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** Read the requested keys out of an in-memory store, mirroring `chrome.storage.get`. */
function readFromStore(
  store: Record<string, unknown>,
  keys?: string | string[] | Record<string, unknown> | null,
): Record<string, unknown> {
  // No keys / null: return a shallow copy of the entire store. Object spread
  // uses CreateDataProperty, so own keys (including "__proto__") are preserved.
  if (keys === undefined || keys === null) {
    return { ...store };
  }

  // Single key. The computed-key literal creates an own property even for
  // "__proto__", so this branch is already hazard-free.
  if (typeof keys === "string") {
    return Object.hasOwn(store, keys) ? { [keys]: store[keys] } : {};
  }

  // Array of keys: only include those present in the store.
  if (Array.isArray(keys)) {
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (Object.hasOwn(store, key)) {
        assignOwn(result, key, store[key]);
      }
    }
    return result;
  }

  // Object of defaults: present keys win, otherwise fall back to the default.
  const result: Record<string, unknown> = {};
  for (const [key, fallback] of Object.entries(keys)) {
    assignOwn(result, key, Object.hasOwn(store, key) ? store[key] : fallback);
  }
  return result;
}

/** Build an in-memory storage area whose methods are recording spies. */
function createStorageArea(
  counter: InvocationOrderCounter,
  registry: Resettable[],
  events: MockEvent[],
): MockStorageArea {
  // A prototype-less store so arbitrary string keys (notably "__proto__") become
  // ordinary own properties on `set`/`get`/`remove`/`clear` instead of mutating
  // the object's prototype. Storage keys are untrusted arbitrary strings.
  const store: Record<string, unknown> = Object.create(null);

  return {
    get: createSpy(counter, registry, (keys?: string | string[] | Record<string, unknown> | null) =>
      Promise.resolve(readFromStore(store, keys)),
    ),
    set: createSpy(counter, registry, (items: Record<string, unknown>) => {
      // Copy own enumerable keys into the prototype-less store. `[[Set]]` on a
      // null-prototype target creates an own "__proto__" property rather than
      // invoking the inherited prototype setter.
      for (const key of Object.keys(items)) {
        assignOwn(store, key, items[key]);
      }
      return Promise.resolve();
    }),
    remove: createSpy(counter, registry, (keys: string | string[]) => {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const key of list) {
        delete store[key];
      }
      return Promise.resolve();
    }),
    clear: createSpy(counter, registry, () => {
      for (const key of Object.keys(store)) {
        delete store[key];
      }
      return Promise.resolve();
    }),
    onChanged: createEvent(counter, registry, events),
    store,
  };
}

/**
 * Wrap a namespace object so that accessing an undefined property throws an
 * error naming the missing path. Symbol access (e.g. `Symbol.iterator`,
 * promise interop) and existing properties pass through untouched, so optional
 * properties defined as `undefined` (like `runtime.lastError`) do not throw.
 */
function guardNamespace<T extends object>(target: T, path: string): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (typeof prop === "symbol" || prop in obj) {
        return Reflect.get(obj, prop, receiver);
      }
      throw new Error(
        `chrome mock: "${path}.${String(prop)}" is not mocked. Add it to createChromeMock() in test/mocks/chrome.ts.`,
      );
    },
  });
}

/**
 * Create a fresh {@link ChromeMock}.
 *
 * The returned mock has empty in-memory storage areas and spy functions with
 * zero recorded calls. Accessing a namespace or member that is not defined
 * throws a descriptive error naming the missing path.
 */
export function createChromeMock(): ChromeMock {
  const counter: InvocationOrderCounter = { value: 0 };
  const spies: Resettable[] = [];
  const events: MockEvent[] = [];
  const storageAreas: MockStorageArea[] = [];

  const session = createStorageArea(counter, spies, events);
  const local = createStorageArea(counter, spies, events);
  storageAreas.push(session, local);

  const storage = guardNamespace({ session, local }, "chrome.storage");

  const runtime = guardNamespace(
    {
      sendMessage: createSpy(counter, spies),
      onMessage: createEvent(counter, spies, events),
      getURL: createSpy<[string], string>(
        counter,
        spies,
        (path) => `chrome-extension://gn-tracing-mock/${path}`,
      ),
      lastError: undefined as { message: string } | undefined,
    },
    "chrome.runtime",
  );

  const tabs = guardNamespace(
    {
      query: createSpy(counter, spies, () => Promise.resolve([])),
      get: createSpy(counter, spies),
      create: createSpy(counter, spies),
      sendMessage: createSpy(counter, spies),
    },
    "chrome.tabs",
  );

  const alarms = guardNamespace(
    {
      create: createSpy(counter, spies),
      clear: createSpy(counter, spies, () => Promise.resolve(true)),
    },
    "chrome.alarms",
  );

  const debuggerNs = guardNamespace(
    {
      attach: createSpy(counter, spies, () => Promise.resolve()),
      detach: createSpy(counter, spies, () => Promise.resolve()),
      sendCommand: createSpy(counter, spies, () => Promise.resolve({})),
      onEvent: createEvent(counter, spies, events),
    },
    "chrome.debugger",
  );

  const action = guardNamespace(
    {
      setBadgeText: createSpy(counter, spies, () => Promise.resolve()),
      setBadgeBackgroundColor: createSpy(counter, spies, () => Promise.resolve()),
    },
    "chrome.action",
  );

  const chrome = guardNamespace(
    {
      storage,
      runtime,
      tabs,
      alarms,
      debugger: debuggerNs,
      action,
    },
    "chrome",
  ) as ChromeMock;

  const internal: InternalMock = { chrome, counter, spies, storageAreas, events };
  // Stash internals behind a symbol so reset can find them without widening the
  // public surface; symbol access bypasses the missing-namespace guard.
  Object.defineProperty(chrome, INTERNAL, {
    value: internal,
    enumerable: false,
    writable: false,
    configurable: true,
  });

  return chrome;
}

/** Retrieve the internal bookkeeping attached to a guarded mock, if present. */
function getInternal(mock: ChromeMock | null): InternalMock | null {
  if (!mock) {
    return null;
  }
  return (mock as unknown as Record<symbol, InternalMock | undefined>)[INTERNAL] ?? null;
}

/**
 * Reset a mock instance in place: clear every storage area, every spy's
 * recorded calls/results, every event's listeners, and the shared invocation
 * counter. Operates on the supplied mock, or the currently installed mock when
 * called with no argument.
 */
function resetInternal(internal: InternalMock): void {
  for (const area of internal.storageAreas) {
    for (const key of Object.keys(area.store)) {
      delete (area.store as Record<string, unknown>)[key];
    }
  }
  for (const event of internal.events) {
    event.listeners.length = 0;
  }
  for (const spy of internal.spies) {
    spy.mockReset();
  }
  internal.counter.value = 0;
}

/**
 * Install a fresh {@link ChromeMock} onto `globalThis.chrome` and return it.
 * The previously installed mock (if any) is replaced.
 */
export function installChromeMock(): ChromeMock {
  const chrome = createChromeMock();
  installedMock = getInternal(chrome);
  (globalThis as { chrome?: unknown }).chrome = chrome;
  return chrome;
}

/**
 * Reset the currently installed Chrome mock so storage areas are empty and
 * every spy's recorded call count is zero. No-op if nothing is installed.
 *
 * @param mock Optional explicit mock to reset instead of the installed one.
 */
export function resetChromeMock(mock?: ChromeMock): void {
  const internal = mock ? getInternal(mock) : installedMock;
  if (internal) {
    resetInternal(internal);
  }
}
