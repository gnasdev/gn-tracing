/**
 * Privacy-safe keyboard event labeling for recording capture.
 *
 * Records named keys and Ctrl/Meta/Alt shortcuts only — never raw typed form
 * or password input. Shared so content-script capture and unit tests use the
 * same allowlist rules.
 */

const SOLO_MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph"]);

const NAMED_KEY_LABELS: Record<string, string> = {
  Enter: "Enter",
  Escape: "Esc",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Insert: "Insert",
  " ": "Space",
};

export type KeyLabelTargetFlags = {
  isFormControl: boolean;
  isSensitive: boolean;
};

function isPrintableSingleKey(key: string): boolean {
  return key.length === 1;
}

function hasNonShiftModifier(flags: {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}): boolean {
  return flags.ctrlKey || flags.metaKey || flags.altKey;
}

function formatPrintableBase(key: string): string {
  if (key.length === 1 && /[a-z]/i.test(key)) {
    return key.toUpperCase();
  }
  return key;
}

/**
 * Build a stable display label for a keydown, or null when the event should not
 * be recorded (repeat, password/sensitive targets, typed form input, solo
 * modifiers, or keys outside the allowlist).
 */
export function formatKeyLabel(
  event: {
    key: string;
    code?: string;
    repeat: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    metaKey: boolean;
  },
  target: KeyLabelTargetFlags,
): string | null {
  if (event.repeat) {
    return null;
  }
  if (SOLO_MODIFIER_KEYS.has(event.key)) {
    return null;
  }
  if (target.isSensitive) {
    return null;
  }

  const named = NAMED_KEY_LABELS[event.key];
  let baseLabel: string | null = null;
  const chord = hasNonShiftModifier(event);

  if (named) {
    if (event.key === " " && target.isFormControl && !chord) {
      return null;
    }
    baseLabel = named;
  } else if (/^F([1-9]|1[0-2])$/.test(event.key)) {
    baseLabel = event.key;
  } else if (isPrintableSingleKey(event.key)) {
    if (chord) {
      baseLabel = formatPrintableBase(event.key);
    } else if (!target.isFormControl) {
      baseLabel = formatPrintableBase(event.key);
    } else {
      return null;
    }
  } else {
    return null;
  }

  const parts: string[] = [];
  if (event.ctrlKey) {
    parts.push("Ctrl");
  }
  if (event.altKey) {
    parts.push("Alt");
  }
  if (event.shiftKey) {
    parts.push("Shift");
  }
  if (event.metaKey) {
    parts.push("Meta");
  }
  parts.push(baseLabel);
  return parts.join("+");
}
