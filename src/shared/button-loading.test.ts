import { describe, expect, it } from "vitest";
import { buttonSpinnerHtml, setButtonLoading } from "./button-loading";

function createMockButton(initialHtml = "<span>Save</span>"): HTMLButtonElement {
  const attrs = new Map<string, string>();
  const classes = new Set<string>(["btn", "btn-secondary"]);
  const button = {
    innerHTML: initialHtml,
    disabled: false,
    get textContent() {
      return button.innerHTML.replace(/<[^>]+>/g, "");
    },
    classList: {
      contains: (name: string) => classes.has(name),
      add: (name: string) => {
        classes.add(name);
      },
      remove: (name: string) => {
        classes.delete(name);
      },
    },
    getAttribute: (name: string) => attrs.get(name) ?? null,
    setAttribute: (name: string, value: string) => {
      attrs.set(name, value);
    },
    removeAttribute: (name: string) => {
      attrs.delete(name);
    },
  };
  return button as unknown as HTMLButtonElement;
}

describe("buttonSpinnerHtml", () => {
  it("returns btn-spinner span", () => {
    expect(buttonSpinnerHtml()).toContain('class="btn-spinner"');
    expect(buttonSpinnerHtml()).toContain('aria-hidden="true"');
  });
});

describe("setButtonLoading", () => {
  it("disables button, sets aria-busy, injects spinner and label", () => {
    const button = createMockButton();
    const handle = setButtonLoading(button, { label: "Saving…", spinner: true });

    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.classList.contains("is-loading")).toBe(true);
    expect(button.innerHTML).toContain("btn-spinner");
    expect(button.textContent).toContain("Saving…");

    handle.clear();
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-busy")).toBeNull();
    expect(button.classList.contains("is-loading")).toBe(false);
    expect(button.innerHTML).toBe("<span>Save</span>");
  });

  it("escapes label text", () => {
    const button = createMockButton();
    setButtonLoading(button, { label: `<img src=x onerror=alert(1)>`, spinner: false });
    expect(button.innerHTML).not.toContain("<img");
    expect(button.innerHTML).toContain("&lt;img");
  });
});
