/**
 * Regression guard for the vendored luna-json-editor widget's real instance
 * API, used read-only by `public/player.js`'s `renderJsonReadonly`.
 *
 * `public/player.js` drives this bundle directly via its UMD global (it
 * cannot `import` npm modules — see design.md PHẦN A.2), based on method
 * names hand-verified in code comments rather than checked by a compiler. A
 * prior bug called a non-existent `LunaJsonEditor#set()` (the real method is
 * `setValue()`); the call threw, was silently swallowed by a try/catch, and
 * every JSON value in the player silently fell back to the legacy renderer —
 * while the aborted widget's constructor had already stamped the mount
 * container with luna's own `user-select: none` class, making the *fallback*
 * text unselectable too (see player.css' `.luna-mount .luna-json-editor`
 * override).
 *
 * This test loads the actual vendored bundle file (not a mock) and exercises
 * the exact calls player.js makes, so a future vendor upgrade that renames a
 * method is caught here instead of silently degrading in production.
 *
 * Needs a real DOM (the widget's constructor calls DOM methods on its
 * container), so it only runs meaningfully under this project's own jsdom
 * vitest context (`cd player-standalone && npm run test`, or `task
 * test:all`). The root extension Context's config also discovers this file
 * (test discovery intentionally spans the whole repo — see
 * `vitest.shared.ts`) but runs under `environment: "node"`, which has no
 * `document`/jsdom install; the skip guard below keeps that run green instead
 * of erroring on a missing dependency.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { beforeAll, describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const vendorDir = path.resolve(__dirname, "../public/vendor/luna");

const hasDom = typeof document !== "undefined";

beforeAll(() => {
  if (!hasDom) return;
  // jsdom (as configured by Vitest's jsdom environment) does not execute
  // <script> elements appended via the DOM API, so run the bundle directly in
  // the test's real global context instead — that's where Vitest's jsdom
  // environment already installed `window`, which is what the UMD wrapper's
  // final fallback branch (`t.LunaJsonEditor = e()`, called as
  // `(window, factory)`) assigns onto, exactly like a real <script> tag would.
  const code = fs.readFileSync(path.join(vendorDir, "luna-json-editor.js"), "utf8");
  vm.runInThisContext(code);
});

describe.skipIf(!hasDom)("vendored luna-json-editor API (used by renderJsonReadonly)", () => {
  // biome-ignore lint/suspicious/noExplicitAny: vendored UMD global, no types shipped
  function createEditor(container: HTMLElement): any {
    // biome-ignore lint/suspicious/noExplicitAny: vendored UMD global, no types shipped
    const JsonEditor = (window as any).LunaJsonEditor;
    return new JsonEditor(container, {
      enableInsert: false,
      enableDelete: false,
      nameEditable: false,
      valueEditable: false,
    });
  }

  it("has no `set` method — callers must use `setValue`", () => {
    const editor = createEditor(document.createElement("div"));
    // This is the regression guard itself: if a future vendor upgrade adds a
    // `set` alias, player.js can switch to it deliberately — not because
    // someone assumed it exists without checking, which is exactly how the
    // original bug shipped.
    expect(typeof editor.set).toBe("undefined");
    expect(typeof editor.setValue).toBe("function");
  });

  it("renders a value via `setValue` without throwing", () => {
    const container = document.createElement("div");
    container.className = "luna-mount storage-value-mount";
    const editor = createEditor(container);

    expect(() => editor.setValue({ a: 1, b: { c: 2 } })).not.toThrow();
    if (typeof editor.expand === "function") {
      editor.expand();
    }

    // The widget's constructor stamps its own classes directly onto the
    // caller-supplied container (it doesn't append a child root), so
    // player.css' `.luna-mount .luna-json-editor` / `.luna-mount.luna-json-editor`
    // override must match this combined-class shape to restore text
    // selection over the vendor's `user-select: none` default.
    expect(container.classList.contains("luna-mount")).toBe(true);
    expect(container.classList.contains("luna-json-editor")).toBe(true);
    expect(container.textContent).toContain("a");
  });
});
