/**
 * Serializing a live DOM into the `DomNode` model.
 *
 * The extension gets its snapshots from CDP's `DOMSnapshot.captureSnapshot`.
 * The in-page SDK has no such API, and instant replay needs snapshots in *both*
 * producers, so this walks the tree directly. Output is the same `DomNode`
 * shape either way, which is what lets the player render both.
 *
 * Three things are deliberately dropped:
 *
 * - **`<script>` contents.** Replaying a snapshot must never execute the page's
 *   code, and shipping script bodies in a bug report leaks source besides.
 * - **Live form values.** `input.value` is what the user typed — a password, a
 *   card number. The `value` *attribute* (the markup default) is kept; the
 *   current value is not, unless the caller opts in.
 * - **Anything under a mask selector**, replaced by a marker node.
 */

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/** Mirrors `DomNode` in `../schema/capture.ts`. */
export interface SerializedDomNode {
  nodeType: number;
  nodeName: string;
  nodeValue?: string;
  attributes?: Record<string, string>;
  children?: SerializedDomNode[];
  masked?: boolean;
}

export interface DomSnapshotOptions {
  /** CSS selectors whose subtrees are replaced with a masked placeholder. */
  maskSelectors?: string[];
  /** Hard ceiling on serialized nodes. Beyond it the walk stops. */
  maxNodes?: number;
  /** Longest text node kept, in characters. */
  maxTextLength?: number;
  /**
   * Include live `input`/`textarea`/`select` values. Off by default: those are
   * the characters the user typed, which is exactly what a bug report should
   * not carry by accident.
   */
  includeFormValues?: boolean;
}

export const DEFAULT_MAX_NODES = 6_000;
export const DEFAULT_MAX_TEXT_LENGTH = 2_000;

const SKIPPED_TAGS = new Set(["SCRIPT", "NOSCRIPT", "TEMPLATE"]);
const VALUE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);
const SENSITIVE_INPUT_TYPES = new Set(["password", "email", "tel", "hidden"]);

export interface DomSnapshotResult {
  root: SerializedDomNode;
  nodeCount: number;
  /** True when `maxNodes` cut the walk short, so a reader knows it is partial. */
  truncated: boolean;
}

/** Serializes `element` and its subtree. */
export function serializeDomTree(
  element: Element | Document,
  options: DomSnapshotOptions = {},
): DomSnapshotResult {
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const maxTextLength = options.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;
  const maskSelectors = options.maskSelectors ?? [];
  const state = { count: 0, truncated: false };

  const rootElement =
    "documentElement" in element && element.documentElement
      ? element.documentElement
      : (element as Element);

  const root = walk(rootElement, {
    maskSelectors,
    maxNodes,
    maxTextLength,
    includeFormValues: options.includeFormValues === true,
    state,
  });

  return {
    root: root ?? { nodeType: ELEMENT_NODE, nodeName: "HTML" },
    nodeCount: state.count,
    truncated: state.truncated,
  };
}

interface WalkContext {
  maskSelectors: string[];
  maxNodes: number;
  maxTextLength: number;
  includeFormValues: boolean;
  state: { count: number; truncated: boolean };
}

function matchesMask(element: Element, selectors: string[]): boolean {
  for (const selector of selectors) {
    try {
      if (element.matches(selector)) {
        return true;
      }
    } catch {
      // An invalid selector must not stop the snapshot; skip it.
    }
  }
  return false;
}

function serializeAttributes(element: Element, context: WalkContext): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const attribute of Array.from(element.attributes)) {
    attributes[attribute.name] = attribute.value;
  }

  if (VALUE_TAGS.has(element.tagName)) {
    const type = element.getAttribute("type")?.toLowerCase() ?? "";
    const sensitive = SENSITIVE_INPUT_TYPES.has(type);
    if (context.includeFormValues && !sensitive) {
      const live = (element as HTMLInputElement).value;
      if (typeof live === "string") {
        attributes.value = live;
      }
    } else if (sensitive) {
      // Keep the field visible in the replay without its contents, so the
      // layout still makes sense.
      delete attributes.value;
      attributes["data-gn-tracing-masked"] = "value";
    }
  }

  return attributes;
}

function walk(node: Node, context: WalkContext): SerializedDomNode | null {
  if (context.state.count >= context.maxNodes) {
    context.state.truncated = true;
    return null;
  }

  if (node.nodeType === TEXT_NODE) {
    const raw = node.nodeValue ?? "";
    if (raw.trim().length === 0) {
      return null;
    }
    context.state.count += 1;
    return {
      nodeType: TEXT_NODE,
      nodeName: "#text",
      nodeValue:
        raw.length > context.maxTextLength ? `${raw.slice(0, context.maxTextLength)}…` : raw,
    };
  }

  if (node.nodeType !== ELEMENT_NODE) {
    return null;
  }

  const element = node as Element;
  if (SKIPPED_TAGS.has(element.tagName)) {
    return null;
  }

  context.state.count += 1;

  if (matchesMask(element, context.maskSelectors)) {
    return {
      nodeType: ELEMENT_NODE,
      nodeName: element.tagName,
      attributes: { "data-gn-tracing-masked": "subtree" },
      masked: true,
    };
  }

  const children: SerializedDomNode[] = [];
  for (const child of Array.from(element.childNodes)) {
    const serialized = walk(child, context);
    if (serialized) {
      children.push(serialized);
    }
    if (context.state.truncated) {
      break;
    }
  }

  const serializedNode: SerializedDomNode = {
    nodeType: ELEMENT_NODE,
    nodeName: element.tagName,
    attributes: serializeAttributes(element, context),
  };
  if (children.length > 0) {
    serializedNode.children = children;
  }
  return serializedNode;
}

/** Rough serialized size, used by the rolling buffer's byte cap. */
export function estimateSnapshotBytes(root: SerializedDomNode): number {
  return JSON.stringify(root).length;
}
