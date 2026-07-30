/**
 * Tests for Item 1 (luna-* UI components) — unit coverage of the player render
 * adapters' safe-fallback and read-only contracts.
 *
 * Covers two Item-1 correctness properties from design.md PHẦN C.3:
 *  - Property P1 (safe fallback, R6.3): when the matching luna global is
 *    `undefined`, `renderObjectValue` / `renderJsonReadonly` fall back to the
 *    legacy renderer and MUST NOT throw.
 *  - Property P2 (read-only, R6.4): when `window.LunaJsonEditor` is present, the
 *    constructed editor instance enforces `options.readOnly === true` because
 *    the player only replays and must not allow edits.
 *
 * The adapters live inside the non-bundled player IIFE (`player/public/player.js`,
 * ~line 1590) and are not importable. Following the same convention as
 * `src/shared/storage-artifact.test.ts` (which mirrors `diffStorageGroups`),
 * the adapter branching logic is mirrored verbatim below. Keep the mirrored
 * `renderObjectValue` / `renderJsonReadonly` byte-for-byte in sync with the
 * canonical implementation in `player/public/player.js`. The legacy helpers
 * (`renderRemoteObject`, `highlightJson`, `remoteObjectToPlain`) are stubbed
 * with observable behavior since they are exercised by other paths; only the
 * adapter branch selection and read-only enforcement are under test here.
 *
 * The root Vitest context runs in a `node` environment (no jsdom), so a minimal
 * fake element that records `innerHTML` / `textContent` stands in for a DOM
 * container — sufficient for the adapters, which only touch those two fields
 * plus the luna constructor/instance API.
 *
 * MANUAL verification (not automatable here): theme dark/light must not break
 * luna CSS. Verified by loading the player with the vendored luna bundles under
 * both `prefers-color-scheme` settings; this file does not assert on rendered
 * CSS. Do not fabricate an automated theme assertion.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Minimal fake DOM container. The adapters only ever read/write `innerHTML`
// and `textContent`, so this stand-in is sufficient under the `node` env.
// ---------------------------------------------------------------------------
interface FakeElement {
  innerHTML: string;
  textContent: string;
}

function makeFakeElement(): FakeElement {
  return { innerHTML: "", textContent: "" };
}

// ---------------------------------------------------------------------------
// Stubs for the player-internal legacy helpers the adapters delegate to. These
// are NOT under test here; they only need observable behavior so the fallback
// branch is detectable.
// ---------------------------------------------------------------------------
function renderRemoteObject(value: unknown): string {
  return `legacy-object:${String((value as { description?: unknown })?.description ?? value)}`;
}

function highlightJson(text: string): string {
  return `highlighted:${text}`;
}

function remoteObjectToPlain(value: unknown): unknown {
  return value;
}

// ---------------------------------------------------------------------------
// Mirror of player.js luna render adapters (~line 1590). Must stay in
// sync with the canonical implementation.
// ---------------------------------------------------------------------------
function renderObjectValueLegacy(container: FakeElement, value: unknown) {
  if (!container) return null;
  container.innerHTML = renderRemoteObject(value);
  return null;
}

function renderObjectValue(container: FakeElement, value: unknown) {
  if (!container) return null;
  const ObjectViewer =
    typeof window !== "undefined"
      ? (window as unknown as { LunaObjectViewer?: unknown }).LunaObjectViewer
      : undefined;
  if (typeof ObjectViewer !== "function") {
    return renderObjectValueLegacy(container, value);
  }
  try {
    container.textContent = "";
    const viewer = new (ObjectViewer as new (c: FakeElement) => { set(v: unknown): void })(
      container,
    );
    viewer.set(remoteObjectToPlain(value));
    return viewer;
  } catch {
    return renderObjectValueLegacy(container, value);
  }
}

function renderJsonLegacy(container: FakeElement, jsonValue: unknown) {
  if (!container) return null;
  let text: string;
  try {
    text = JSON.stringify(jsonValue, null, 2);
  } catch {
    text = String(jsonValue);
  }
  container.innerHTML = `<pre class="json-preview-body response-code-block">${highlightJson(text)}</pre>`;
  return null;
}

function renderJsonReadonly(container: FakeElement, jsonValue: unknown) {
  if (!container) return null;
  const JsonEditor =
    typeof window !== "undefined"
      ? (window as unknown as { LunaJsonEditor?: unknown }).LunaJsonEditor
      : undefined;
  if (typeof JsonEditor !== "function") {
    return renderJsonLegacy(container, jsonValue);
  }
  try {
    container.textContent = "";
    const editor = new (
      JsonEditor as new (
        c: FakeElement,
        o: Record<string, unknown>,
      ) => { options?: Record<string, unknown>; set(v: unknown): void; expand?: () => void }
    )(container, {
      // Enforce read-only (player only replays): disable every edit affordance.
      enableInsert: false,
      enableDelete: false,
      nameEditable: false,
      valueEditable: false,
    });
    // Data MUST be applied via .set() — the constructor does not read a value.
    editor.set(jsonValue);
    // Mirror the read-only intent on the instance options (R6.4 / Property P2).
    editor.options = editor.options || {};
    editor.options.readOnly = true;
    if (typeof editor.expand === "function") {
      editor.expand();
    }
    return editor;
  } catch {
    return renderJsonLegacy(container, jsonValue);
  }
}

// ---------------------------------------------------------------------------
// Test doubles for the luna globals.
// ---------------------------------------------------------------------------
type LunaWindow = {
  LunaObjectViewer?: unknown;
  LunaJsonEditor?: unknown;
};

// The adapters guard on `typeof window !== "undefined"` (browser global). The
// root context runs under `node` where `window` is absent, so alias it onto
// `globalThis` for the duration of this suite to faithfully exercise the guard.
const hadWindow = "window" in globalThis;

function lunaGlobals(): LunaWindow {
  return (globalThis as unknown as { window: LunaWindow }).window;
}

beforeAll(() => {
  if (!hadWindow) {
    (globalThis as unknown as { window: unknown }).window = globalThis;
  }
});

afterAll(() => {
  if (!hadWindow) {
    delete (globalThis as unknown as { window?: unknown }).window;
  }
});

afterEach(() => {
  // Always clear the stubbed globals so cases stay isolated.
  const g = lunaGlobals();
  g.LunaObjectViewer = undefined;
  g.LunaJsonEditor = undefined;
});

describe("renderObjectValue — safe fallback (R6.3 / Property P1)", () => {
  it("falls back to the legacy renderer without throwing when LunaObjectViewer is undefined", () => {
    lunaGlobals().LunaObjectViewer = undefined;
    const container = makeFakeElement();

    let result: unknown;
    expect(() => {
      result = renderObjectValue(container, { description: "hello" });
    }).not.toThrow();

    // Legacy path returns null and writes the legacy markup into the container.
    expect(result).toBeNull();
    expect(container.innerHTML).toBe("legacy-object:hello");
  });

  it("falls back to the legacy renderer when the luna constructor throws", () => {
    lunaGlobals().LunaObjectViewer = function ThrowingViewer() {
      throw new Error("boom");
    };
    const container = makeFakeElement();

    let result: unknown;
    expect(() => {
      result = renderObjectValue(container, { description: "x" });
    }).not.toThrow();

    expect(result).toBeNull();
    expect(container.innerHTML).toBe("legacy-object:x");
  });

  it("uses the luna viewer when LunaObjectViewer is present", () => {
    const setSpy = vi.fn();
    lunaGlobals().LunaObjectViewer = class {
      set = setSpy;
    };
    const container = makeFakeElement();

    const viewer = renderObjectValue(container, { description: "y" });

    expect(viewer).not.toBeNull();
    expect(setSpy).toHaveBeenCalledTimes(1);
    // The luna path clears the container instead of writing legacy HTML.
    expect(container.textContent).toBe("");
    expect(container.innerHTML).toBe("");
  });
});

describe("renderJsonReadonly — safe fallback (R6.3 / Property P1)", () => {
  it("falls back to the legacy renderer without throwing when LunaJsonEditor is undefined", () => {
    lunaGlobals().LunaJsonEditor = undefined;
    const container = makeFakeElement();

    let result: unknown;
    expect(() => {
      result = renderJsonReadonly(container, { a: 1 });
    }).not.toThrow();

    expect(result).toBeNull();
    expect(container.innerHTML).toContain("json-preview-body");
    expect(container.innerHTML).toContain("highlighted:");
  });

  it("falls back to the legacy renderer when the luna constructor throws", () => {
    lunaGlobals().LunaJsonEditor = function ThrowingEditor() {
      throw new Error("boom");
    };
    const container = makeFakeElement();

    let result: unknown;
    expect(() => {
      result = renderJsonReadonly(container, { a: 1 });
    }).not.toThrow();

    expect(result).toBeNull();
    expect(container.innerHTML).toContain("json-preview-body");
  });
});

describe("renderJsonReadonly — read-only contract (R6.4 / Property P2)", () => {
  it("enforces options.readOnly === true on the editor instance and applies data via set()", () => {
    let capturedOptions: Record<string, unknown> | undefined;
    const setSpy = vi.fn();
    lunaGlobals().LunaJsonEditor = class {
      options: Record<string, unknown>;
      set = setSpy;
      constructor(_container: FakeElement, options: Record<string, unknown>) {
        // Simulate a bundle that drops options during normalization, proving the
        // adapter re-asserts read-only on the instance afterwards.
        capturedOptions = options;
        this.options = { nameEditable: options.nameEditable };
      }
      expand = vi.fn();
    };
    const container = makeFakeElement();

    const editor = renderJsonReadonly(container, { secret: "value" }) as {
      options: Record<string, unknown>;
    };

    expect(editor).not.toBeNull();
    expect(editor.options.readOnly).toBe(true);
    // Data is applied through .set() (the constructor does not read a value).
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledWith({ secret: "value" });
    // The constructor disables every edit affordance.
    expect(capturedOptions?.nameEditable).toBe(false);
    expect(capturedOptions?.valueEditable).toBe(false);
    expect(capturedOptions?.enableInsert).toBe(false);
    expect(capturedOptions?.enableDelete).toBe(false);
  });

  it("creates the editor.options object when the bundle does not expose one", () => {
    lunaGlobals().LunaJsonEditor = class {
      // No `options` field at all — adapter must create it.
      set = vi.fn();
      expand = vi.fn();
    };
    const container = makeFakeElement();

    const editor = renderJsonReadonly(container, { a: 1 }) as {
      options: Record<string, unknown>;
    };

    expect(editor.options).toBeDefined();
    expect(editor.options.readOnly).toBe(true);
  });
});
