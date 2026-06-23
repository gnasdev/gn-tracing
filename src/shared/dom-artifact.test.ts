/**
 * Tests for Item 3 (Elements/DOM snapshot panel) — unit + property-based.
 *
 * Covers three Item-3 surfaces:
 *  - `#flattenDomSnapshot` — rebuilding the `DOMSnapshot.captureSnapshot`
 *    index-array structure (documents + shared `strings` table) into a
 *    well-formed `DomNode` tree (R7.2 / Property P5).
 *  - `#maskDomTree` selector masking — a node matching a `maskDomSelectors`
 *    entry is flagged `masked === true` and its `nodeValue`/attribute values are
 *    replaced with `REDACTED_VALUE` (R7.3 / Property P2).
 *  - Round-trip serialize/parse of `DomArtifact` (Property P3 / R2.5).
 *
 * `#flattenDomSnapshot`, `#maskDomTree`, and the compound-selector matcher are
 * private methods of `CdpManager` (`src/background/cdp-manager.ts`, tasks
 * 14.1/14.2) and are not importable. Following the same convention as
 * `src/shared/storage-artifact.test.ts`, the algorithms under test are mirrored
 * verbatim below. Keep them byte-for-byte in sync with `cdp-manager.ts`.
 *
 * fast-check global config (numRuns, verbose, seed reporting) is applied via the
 * `test/property-config.ts` setup file.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { DomArtifact, DomNode, DomSnapshot } from "../types/recording";
import { normalizeMaskDomSelectors, REDACTED_VALUE } from "./privacy-redaction";

// ---------------------------------------------------------------------------
// Mirror of CdpManager `DOMSnapshot.captureSnapshot` response shape. The
// response is a flattened, index-array structure: per-document `nodes` arrays
// whose entries are aligned by index, with string fields as indices into the
// shared `strings` table (`-1` means "no string").
// ---------------------------------------------------------------------------
interface CdpDomNodeTreeSnapshot {
  parentIndex?: number[];
  nodeType?: number[];
  nodeName?: number[];
  nodeValue?: number[];
  attributes?: number[][];
}

interface CdpDomDocumentSnapshot {
  documentURL?: number;
  nodes: CdpDomNodeTreeSnapshot;
}

interface CdpDomSnapshotResult {
  documents?: CdpDomDocumentSnapshot[];
  strings?: string[];
}

// ---------------------------------------------------------------------------
// Mirror of CdpManager.#flattenDomSnapshot (cdp-manager.ts ~line 2039). Must
// stay in sync with the canonical implementation. Builds a well-formed DomNode
// tree from the index-array structure; each node is attached to at most one
// strictly-earlier parent (`parentIndex < i`) so cycles are impossible.
// ---------------------------------------------------------------------------
function flattenDomSnapshot(result: CdpDomSnapshotResult): DomNode {
  const strings = result.strings ?? [];
  const resolveString = (index: number | undefined): string | undefined => {
    if (index === undefined || index < 0 || index >= strings.length) return undefined;
    return strings[index];
  };

  const emptyRoot = (): DomNode => ({ nodeType: 9, nodeName: "#document" });

  const document = result.documents?.[0];
  if (!document) return emptyRoot();

  const nodes = document.nodes;
  const parentIndex = nodes.parentIndex ?? [];
  const nodeType = nodes.nodeType ?? [];
  const nodeName = nodes.nodeName ?? [];
  const nodeValue = nodes.nodeValue ?? [];
  const attributes = nodes.attributes ?? [];
  const count = Math.max(parentIndex.length, nodeType.length, nodeName.length, nodeValue.length);
  if (count === 0) return emptyRoot();

  // Pass 1: materialize a DomNode per snapshot index.
  const domNodes: DomNode[] = [];
  for (let i = 0; i < count; i++) {
    const node: DomNode = {
      nodeType: nodeType[i] ?? 0,
      nodeName: resolveString(nodeName[i]) ?? "",
    };
    const value = resolveString(nodeValue[i]);
    if (value !== undefined) {
      node.nodeValue = value;
    }
    const attrIndices = attributes[i];
    if (attrIndices && attrIndices.length > 0) {
      const attrs: Record<string, string> = {};
      for (let a = 0; a + 1 < attrIndices.length; a += 2) {
        const name = resolveString(attrIndices[a]);
        if (name === undefined) continue;
        attrs[name] = resolveString(attrIndices[a + 1]) ?? "";
      }
      if (Object.keys(attrs).length > 0) {
        node.attributes = attrs;
      }
    }
    domNodes.push(node);
  }

  // Pass 2: link each node to its parent. Only attach to a strictly-earlier
  // valid parent so the result cannot contain a cycle and every node has at
  // most one parent.
  let rootIndex = -1;
  for (let i = 0; i < count; i++) {
    const parent = parentIndex[i];
    if (parent === undefined || parent < 0) {
      if (rootIndex < 0) rootIndex = i;
      continue;
    }
    if (parent >= i || parent >= count) continue;
    const parentNode = domNodes[parent];
    if (!parentNode.children) {
      parentNode.children = [];
    }
    parentNode.children.push(domNodes[i]);
  }

  return domNodes[rootIndex < 0 ? 0 : rootIndex];
}

// ---------------------------------------------------------------------------
// Mirror of CdpManager compound-selector matcher + the selector-masking pass of
// #maskDomTree (cdp-manager.ts ~lines 2135-2310). The production method also
// runs a sensitive-value redaction pass for unmasked nodes via the shared
// `redactJsonValue` policy (exercised in storage-artifact.test.ts) and records
// redaction hits as a side effect; that side effect is intentionally omitted
// here so the mirror is a pure function focused on selector masking (R7.3).
// ---------------------------------------------------------------------------
interface CompoundSelector {
  tag?: string;
  id?: string;
  classes: string[];
  attrs: Array<{ name: string; value?: string }>;
}

function parseCompoundSelector(selector: string): CompoundSelector | null {
  const tokens = selector
    .trim()
    .split(/[\s>+~]+/)
    .filter(Boolean);
  const last = tokens[tokens.length - 1];
  if (!last) return null;

  const compound: CompoundSelector = { classes: [], attrs: [] };
  const pattern =
    /([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[\s*([\w:-]+)\s*(?:[*^$|~]?=\s*["']?([^"'\]]*)["']?\s*)?\]/g;
  let consumed = 0;
  let match: RegExpExecArray | null = pattern.exec(last);
  while (match !== null) {
    consumed += match[0].length;
    if (match[1]) {
      compound.tag = match[1].toLowerCase();
    } else if (match[2]) {
      compound.id = match[2];
    } else if (match[3]) {
      compound.classes.push(match[3]);
    } else if (match[4]) {
      compound.attrs.push({ name: match[4].toLowerCase(), value: match[5] });
    }
    match = pattern.exec(last);
  }

  if (consumed !== last.length) return null;
  if (
    compound.tag === undefined &&
    compound.id === undefined &&
    compound.classes.length === 0 &&
    compound.attrs.length === 0
  ) {
    return null;
  }
  return compound;
}

function nodeMatchesCompound(node: DomNode, compound: CompoundSelector): boolean {
  const attributes = node.attributes ?? {};
  if (compound.tag && node.nodeName.toLowerCase() !== compound.tag) {
    return false;
  }
  if (compound.id !== undefined && attributes.id !== compound.id) {
    return false;
  }
  if (compound.classes.length > 0) {
    const classList = (attributes.class ?? "").split(/\s+/).filter(Boolean);
    if (!compound.classes.every((cls) => classList.includes(cls))) {
      return false;
    }
  }
  for (const attr of compound.attrs) {
    const key = Object.keys(attributes).find((name) => name.toLowerCase() === attr.name);
    if (key === undefined) return false;
    if (attr.value !== undefined && attributes[key] !== attr.value) {
      return false;
    }
  }
  return true;
}

function nodeMatchesCompounds(node: DomNode, compounds: CompoundSelector[]): boolean {
  if (node.nodeType !== 1) return false;
  return compounds.some((compound) => nodeMatchesCompound(node, compound));
}

function maskDomTree(root: DomNode, maskDomSelectors: string[]): DomNode {
  const selectors = normalizeMaskDomSelectors(maskDomSelectors);
  const compounds = selectors
    .map((selector) => parseCompoundSelector(selector))
    .filter((compound): compound is CompoundSelector => compound !== null);

  const walk = (node: DomNode, inMaskedSubtree: boolean): void => {
    const masked =
      inMaskedSubtree || (compounds.length > 0 && nodeMatchesCompounds(node, compounds));

    if (masked) {
      node.masked = true;
      if (node.nodeValue !== undefined && node.nodeValue !== "") {
        node.nodeValue = REDACTED_VALUE;
      }
      if (node.attributes) {
        for (const name of Object.keys(node.attributes)) {
          if (node.attributes[name] !== "") {
            node.attributes[name] = REDACTED_VALUE;
          }
        }
      }
    }

    if (node.children) {
      for (const child of node.children) {
        walk(child, masked);
      }
    }
  };

  walk(root, false);
  return root;
}

// ---------------------------------------------------------------------------
// isTree: a node reachable from the root via two distinct paths (a cycle, or a
// node with >1 parent) is detected by encountering the same object reference
// twice during a depth-first walk. Returns false on the first repeat visit.
// ---------------------------------------------------------------------------
function isTree(root: DomNode): boolean {
  const seen = new Set<DomNode>();
  const stack: DomNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as DomNode;
    if (seen.has(node)) return false;
    seen.add(node);
    if (node.children) {
      for (const child of node.children) {
        stack.push(child);
      }
    }
  }
  return true;
}

describe("flattenDomSnapshot (index-array → tree, R7.2 / Property P5)", () => {
  it("resolves names/values/attributes and parent-child links from the strings table", () => {
    // strings table shared by the index-array structure.
    const strings = ["#document", "html", "body", "div", "hello", "id", "main", "#text"];
    const result: CdpDomSnapshotResult = {
      strings,
      documents: [
        {
          documentURL: -1,
          nodes: {
            // node order: #document(0) > html(1) > body(2) > div#main(3) > #text(4)
            parentIndex: [-1, 0, 1, 2, 3],
            nodeType: [9, 1, 1, 1, 3],
            nodeName: [0, 1, 2, 3, 7],
            nodeValue: [-1, -1, -1, -1, 4],
            attributes: [[], [], [], [5, 6], []],
          },
        },
      ],
    };

    const root = flattenDomSnapshot(result);

    // Root resolves from the strings table.
    expect(root.nodeType).toBe(9);
    expect(root.nodeName).toBe("#document");
    expect(root.nodeValue).toBeUndefined();

    // Parent → child links rebuilt in document order.
    const html = root.children?.[0];
    expect(html?.nodeName).toBe("html");
    const body = html?.children?.[0];
    expect(body?.nodeName).toBe("body");

    // Attribute name/value indices resolve to "id" → "main".
    const div = body?.children?.[0];
    expect(div?.nodeName).toBe("div");
    expect(div?.attributes).toEqual({ id: "main" });

    // Text node value resolves from the strings table.
    const text = div?.children?.[0];
    expect(text?.nodeType).toBe(3);
    expect(text?.nodeName).toBe("#text");
    expect(text?.nodeValue).toBe("hello");

    // The flattened tree is well-formed.
    expect(isTree(root)).toBe(true);
  });

  it("returns an empty #document root when there are no documents", () => {
    expect(flattenDomSnapshot({ strings: [] })).toEqual({ nodeType: 9, nodeName: "#document" });
    expect(flattenDomSnapshot({ strings: [], documents: [] })).toEqual({
      nodeType: 9,
      nodeName: "#document",
    });
  });

  it("ignores forward/self parent references so the tree stays acyclic", () => {
    const strings = ["#document", "a", "b", "c"];
    const result: CdpDomSnapshotResult = {
      strings,
      documents: [
        {
          nodes: {
            // node1 points forward (parent 3 >= 1) → not attached;
            // node2 self-references (parent 2 >= 2) → not attached;
            // node3 attaches to root (0).
            parentIndex: [-1, 3, 2, 0],
            nodeType: [9, 1, 1, 1],
            nodeName: [0, 1, 2, 3],
          },
        },
      ],
    };

    const root = flattenDomSnapshot(result);
    expect(root.nodeName).toBe("#document");
    // Only node3 ("c") is a valid (strictly-earlier) child of the root.
    expect(root.children?.map((c) => c.nodeName)).toEqual(["c"]);
    expect(isTree(root)).toBe(true);
  });
});

describe("maskDomTree selector masking (R7.3 / Property P2)", () => {
  const buildTree = (): DomNode => ({
    nodeType: 9,
    nodeName: "#document",
    children: [
      {
        nodeType: 1,
        nodeName: "DIV",
        attributes: { id: "secret-box", class: "card private", "data-private": "yes" },
        nodeValue: "container",
        children: [
          {
            nodeType: 1,
            nodeName: "SPAN",
            attributes: { class: "label" },
            children: [{ nodeType: 3, nodeName: "#text", nodeValue: "sensitive customer email" }],
          },
        ],
      },
      {
        nodeType: 1,
        nodeName: "P",
        attributes: { class: "public" },
        children: [{ nodeType: 3, nodeName: "#text", nodeValue: "public text" }],
      },
    ],
  });

  const findByName = (root: DomNode, name: string): DomNode | undefined => {
    const stack: DomNode[] = [root];
    while (stack.length > 0) {
      const node = stack.pop() as DomNode;
      if (node.nodeName === name) return node;
      if (node.children) stack.push(...node.children);
    }
    return undefined;
  };

  it("masks a node matching a tag selector and redacts its text/attributes", () => {
    const tree = maskDomTree(buildTree(), ["div"]);
    const div = findByName(tree, "DIV");
    expect(div?.masked).toBe(true);
    expect(div?.nodeValue).toBe(REDACTED_VALUE);
    expect(div?.nodeValue).not.toBe("container");
    expect(div?.attributes?.id).toBe(REDACTED_VALUE);
    expect(div?.attributes?.class).toBe(REDACTED_VALUE);

    // A non-matching sibling is left untouched.
    const p = findByName(tree, "P");
    expect(p?.masked).toBeUndefined();
    expect(p?.attributes?.class).toBe("public");
  });

  it("masks via #id, .class, [attr], and compound selectors", () => {
    for (const selector of [
      "#secret-box",
      ".private",
      "[data-private]",
      "div.card[data-private]",
    ]) {
      const div = findByName(maskDomTree(buildTree(), [selector]), "DIV");
      expect(div?.masked, `selector ${selector}`).toBe(true);
      expect(div?.attributes?.id, `selector ${selector}`).toBe(REDACTED_VALUE);
    }
  });

  it("matches [attr=value] only when the value matches", () => {
    expect(findByName(maskDomTree(buildTree(), ['[data-private="yes"]']), "DIV")?.masked).toBe(
      true,
    );
    expect(
      findByName(maskDomTree(buildTree(), ['[data-private="no"]']), "DIV")?.masked,
    ).toBeUndefined();
  });

  it("propagates masking to descendants so original text never survives", () => {
    const tree = maskDomTree(buildTree(), ["#secret-box"]);
    const div = findByName(tree, "DIV");
    // The descendant #text node under the masked DIV is masked and redacted.
    const text = div ? findByName(div, "#text") : undefined;
    expect(text?.masked).toBe(true);
    expect(text?.nodeValue).toBe(REDACTED_VALUE);

    // The original sensitive string does not appear anywhere in the subtree.
    expect(JSON.stringify(div)).not.toContain("sensitive customer email");
  });

  it("does not mask anything when there are no selectors", () => {
    const tree = maskDomTree(buildTree(), []);
    expect(findByName(tree, "DIV")?.masked).toBeUndefined();
    expect(findByName(tree, "DIV")?.nodeValue).toBe("container");
  });
});

describe("flattenDomSnapshot tree well-formed (Property P5 / R7.2)", () => {
  /**
   * Property P5 (tree well-formed): for arbitrary index-array inputs — including
   * invalid parent references (negative, self, forward) — the flattened tree is
   * always a tree: every reachable node has at most one parent and there are no
   * cycles. `isTree` returns false the moment any node is reached twice.
   *
   * **Validates: Requirements 7.2**
   */
  it("produces an acyclic single-parent tree for arbitrary parentIndex arrays", () => {
    // A strings table so node names resolve to something.
    const stringsArb = fc.array(fc.string(), { minLength: 1, maxLength: 8 });

    fc.assert(
      fc.property(fc.integer({ min: 1, max: 40 }), stringsArb, (count, strings): void => {
        // parentIndex entries span the full range incl. invalid refs:
        // -1 (root), >= i (forward/self), and valid (< i) values.
        const parentArb = fc.array(fc.integer({ min: -2, max: count + 2 }), {
          minLength: count,
          maxLength: count,
        });
        const stringIndexArb = fc.array(fc.integer({ min: -1, max: strings.length }), {
          minLength: count,
          maxLength: count,
        });

        fc.assert(
          fc.property(
            parentArb,
            stringIndexArb,
            fc.array(fc.integer({ min: 0, max: 12 }), { minLength: count, maxLength: count }),
            (parentIndex, nameIndices, nodeType): void => {
              const result: CdpDomSnapshotResult = {
                strings,
                documents: [
                  {
                    nodes: {
                      parentIndex,
                      nodeType,
                      nodeName: nameIndices,
                      nodeValue: nameIndices,
                    },
                  },
                ],
              };

              const root = flattenDomSnapshot(result);
              // No node is reachable via two paths → ≤ 1 parent and no cycle.
              expect(isTree(root)).toBe(true);
            },
          ),
          { numRuns: 25 },
        );
      }),
    );
  });
});

describe("DomArtifact round-trip serialize/parse (R2.5 / Property P3)", () => {
  // Bounded-depth DomNode generator. Only ever emits defined fields (optional
  // keys are governed by `requiredKeys`) so the serialized form is a faithful
  // representation that parses back deep-equal. Attribute keys are drawn from a
  // safe alphabet to avoid the JSON `__proto__` own-property pitfall.
  const attributesArb: fc.Arbitrary<Record<string, string>> = fc.dictionary(
    fc.constantFrom("id", "class", "type", "href", "data-x", "title"),
    fc.string(),
    { maxKeys: 4 },
  );

  const domNodeArb = (depth: number): fc.Arbitrary<DomNode> => {
    const leafKeys = {
      nodeType: fc.integer({ min: 1, max: 12 }),
      nodeName: fc.string(),
      nodeValue: fc.string(),
      attributes: attributesArb,
      masked: fc.boolean(),
    };
    if (depth <= 0) {
      return fc.record(leafKeys, {
        requiredKeys: ["nodeType", "nodeName"],
      }) as fc.Arbitrary<DomNode>;
    }
    return fc.record(
      {
        ...leafKeys,
        children: fc.array(domNodeArb(depth - 1), { maxLength: 3 }),
      },
      { requiredKeys: ["nodeType", "nodeName"] },
    ) as fc.Arbitrary<DomNode>;
  };

  const snapshotArb: fc.Arbitrary<DomSnapshot> = fc.record({
    label: fc.oneof(
      fc.constantFrom("start" as const, "stop" as const),
      fc.string({ minLength: 1 }),
    ),
    capturedAt: fc.integer({ min: 0, max: 4_102_444_800_000 }),
    documentUrl: fc.webUrl(),
    root: domNodeArb(4),
  });

  const artifactArb: fc.Arbitrary<DomArtifact> = fc.record({
    schemaVersion: fc.constant(1 as const),
    snapshots: fc.array(snapshotArb, { maxLength: 3 }),
  });

  /**
   * Property P3 (round-trip): a DomArtifact survives serialize→parse unchanged:
   * `parse(JSON.stringify(artifact))` deep-equals `artifact`.
   *
   * **Validates: Requirements 2.5**
   */
  it("preserves a DomArtifact through JSON serialize/parse", () => {
    fc.assert(
      fc.property(artifactArb, (artifact) => {
        const roundTripped = JSON.parse(JSON.stringify(artifact)) as DomArtifact;
        expect(roundTripped).toEqual(artifact);
      }),
    );
  });

  it("round-trips a representative DOM artifact example", () => {
    const artifact: DomArtifact = {
      schemaVersion: 1,
      snapshots: [
        {
          label: "start",
          capturedAt: 1700000000000,
          documentUrl: "https://example.com/",
          root: {
            nodeType: 9,
            nodeName: "#document",
            children: [
              {
                nodeType: 1,
                nodeName: "div",
                attributes: { id: "secret", class: "card" },
                masked: true,
                nodeValue: REDACTED_VALUE,
                children: [{ nodeType: 3, nodeName: "#text", nodeValue: "visible" }],
              },
            ],
          },
        },
      ],
    };
    expect(JSON.parse(JSON.stringify(artifact))).toEqual(artifact);
  });
});
