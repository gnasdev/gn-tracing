import { describe, expect, it } from "vitest";
import { formatKeyLabel } from "./key-event";

const plain = { isFormControl: false, isSensitive: false };
const form = { isFormControl: true, isSensitive: false };
const sensitive = { isFormControl: true, isSensitive: true };

function key(
  partial: Partial<{
    key: string;
    code: string;
    repeat: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    metaKey: boolean;
  }>,
) {
  return {
    key: "a",
    repeat: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...partial,
  };
}

describe("formatKeyLabel", () => {
  it("records named navigation keys", () => {
    expect(formatKeyLabel(key({ key: "Enter" }), plain)).toBe("Enter");
    expect(formatKeyLabel(key({ key: "Escape" }), plain)).toBe("Esc");
    expect(formatKeyLabel(key({ key: "ArrowDown" }), form)).toBe("ArrowDown");
    expect(formatKeyLabel(key({ key: "Tab", shiftKey: true }), form)).toBe("Shift+Tab");
  });

  it("records function keys and chords", () => {
    expect(formatKeyLabel(key({ key: "F5" }), plain)).toBe("F5");
    expect(formatKeyLabel(key({ key: "s", ctrlKey: true }), plain)).toBe("Ctrl+S");
    expect(formatKeyLabel(key({ key: "s", metaKey: true }), form)).toBe("Meta+S");
    expect(formatKeyLabel(key({ key: "Enter", ctrlKey: true }), form)).toBe("Ctrl+Enter");
  });

  it("skips typed input inside form controls", () => {
    expect(formatKeyLabel(key({ key: "a" }), form)).toBeNull();
    expect(formatKeyLabel(key({ key: "1" }), form)).toBeNull();
    expect(formatKeyLabel(key({ key: " " }), form)).toBeNull();
  });

  it("records Space and printable keys outside form controls", () => {
    expect(formatKeyLabel(key({ key: " " }), plain)).toBe("Space");
    expect(formatKeyLabel(key({ key: "a" }), plain)).toBe("A");
    expect(formatKeyLabel(key({ key: "/" }), plain)).toBe("/");
  });

  it("skips sensitive targets, repeats, and solo modifiers", () => {
    expect(formatKeyLabel(key({ key: "Enter" }), sensitive)).toBeNull();
    expect(formatKeyLabel(key({ key: "Enter", repeat: true }), plain)).toBeNull();
    expect(formatKeyLabel(key({ key: "Shift" }), plain)).toBeNull();
    expect(formatKeyLabel(key({ key: "Meta" }), plain)).toBeNull();
  });

  it("records Space chord inside form controls", () => {
    expect(formatKeyLabel(key({ key: " ", ctrlKey: true }), form)).toBe("Ctrl+Space");
  });
});
