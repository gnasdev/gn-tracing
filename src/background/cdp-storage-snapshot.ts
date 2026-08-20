/**
 * Storage and DOM snapshot capture, split out of `CdpManager`.
 *
 * Moved verbatim (not rewritten): `CdpManager` owns load-bearing CDP protocol
 * handling that a rewrite could subtly break in ways no test catches until a
 * real recording is inspected (see `platform/evidence/cdp-collector.ts`). This
 * module only relocates the storage/DOM-snapshot slice, which is the one part
 * of `CdpManager` that never touches the network/websocket/console event
 * pipeline or its pending-request maps — it needs only the tab id, the current
 * privacy/capture settings, and a `StorageManager` to push finished snapshots
 * into.
 */

import {
  getPrivacyProfileSettings,
  normalizeMaskDomSelectors,
  REDACTED_VALUE,
  redactJsonValue,
} from "../shared/privacy-redaction";
import type { PrivacyRedactionSettings } from "../types/messages";
import type {
  CookieRecord,
  DomNode,
  RedactionHit,
  StorageKeyValue,
  StorageSnapshot,
} from "../types/recording";
import type { StorageManager } from "./storage-manager";

interface CdpDomStorageItemsResult {
  entries?: [string, string][]; // [key, value][]
}

/**
 * DOMSnapshot.captureSnapshot result.
 *
 * The response is a flattened, index-array structure: per-document `nodes`
 * arrays whose entries are aligned by index (the node at position `i` is
 * described by `nodeType[i]`, `nodeName[i]`, `parentIndex[i]`, ...). String
 * fields (`nodeName`, `nodeValue`, attribute name/value) are indices into the
 * shared `strings` table; `-1` means "no string". `parentIndex[i] === -1`
 * marks the document root. `attributes[i]` is a flat array of alternating
 * [nameIndex, valueIndex, ...] string indices for node `i`.
 */
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

/**
 * Parsed representation of a single compound CSS selector used for best-effort
 * DOM masking. Supports tag/id/class/attribute parts; combinators are not
 * modeled (the rightmost compound is parsed instead).
 */
interface CompoundSelector {
  tag?: string;
  id?: string;
  classes: string[];
  attrs: Array<{ name: string; value?: string }>;
}

interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  size?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

interface CdpCookiesResult {
  cookies?: CdpCookie[];
}

// DOM snapshot size/depth guards (R7.4). A snapshot exceeding any of these is
// skipped (not buffered) and a limitation is recorded so the package stays
// small enough to upload. `computedStyles` is already dropped at capture time.
const MAX_DOM_TREE_DEPTH = 50;
const MAX_DOM_TREE_NODES = 25_000;
const MAX_DOM_TREE_SERIALIZED_BYTES = 4 * 1024 * 1024;

export interface CdpStorageSnapshotCaptureSettings {
  redactStorageValues: boolean;
  redactDomTextContent: boolean;
}

/**
 * Captures localStorage/sessionStorage/cookies snapshots and static DOM
 * snapshots for the active tab. Owns no network/websocket/console state; the
 * caller (`CdpManager`) is responsible for knowing the debugger is attached
 * and for gating calls on the `captureStorage`/`captureDomSnapshots` settings.
 */
export class CdpStorageSnapshotCollector {
  #storage: StorageManager;
  #privacySettings: PrivacyRedactionSettings = getPrivacyProfileSettings("standard");
  #recordRedactionHits: (hits: RedactionHit[]) => void = () => {};
  #captureSettings: CdpStorageSnapshotCaptureSettings = {
    redactStorageValues: true,
    redactDomTextContent: true,
  };
  #storageLimitations: string[] = [];

  constructor(storage: StorageManager) {
    this.#storage = storage;
  }

  setCaptureSettings(settings: CdpStorageSnapshotCaptureSettings): void {
    this.#captureSettings = settings;
  }

  setPrivacySettings(
    settings: PrivacyRedactionSettings,
    recordRedactionHits?: (hits: RedactionHit[]) => void,
  ): void {
    this.#privacySettings = settings;
    this.#recordRedactionHits = recordRedactionHits || (() => {});
  }

  /** Called from `CdpManager.attach()`: clear limitations from a prior session. */
  reset(): void {
    this.#storageLimitations = [];
  }

  /**
   * Returns the privacy limitations recorded while capturing storage snapshots
   * (e.g. a CDP query that failed and forced a partial snapshot). The
   * service-worker aggregates these into RecordingPrivacySummary.limitations.
   */
  getStorageLimitations(): string[] {
    return [...this.#storageLimitations];
  }

  /**
   * Captures a localStorage/sessionStorage/cookies snapshot for a single phase.
   *
   * Pre: the debugger is attached to `tabId`. Post: the redacted snapshot is
   * pushed to StorageManager.
   *
   * Each CDP query is wrapped in try/catch (see #getDomStorageItems /
   * #getAllCookies): a failing query records a privacy limitation and yields an
   * empty result so recording continues with a partial snapshot instead of
   * aborting.
   */
  async captureStorageSnapshot(tabId: number, phase: "start" | "stop"): Promise<void> {
    const debuggee: chrome.debugger.Debuggee = { tabId };
    const { origin, hostname } = await this.#resolveSecurityOrigin(tabId);

    const [local, session, cookies] = await Promise.all([
      // CDP `isLocalStorage`: true -> localStorage, false -> sessionStorage.
      this.#getDomStorageItems(debuggee, origin, true),
      this.#getDomStorageItems(debuggee, origin, false),
      this.#getAllCookies(debuggee, hostname),
    ]);

    const snapshot: StorageSnapshot = {
      phase,
      capturedAt: Date.now(),
      localStorage: this.#redactStorageItems(local, "storage.localStorage"),
      sessionStorage: this.#redactStorageItems(session, "storage.sessionStorage"),
      cookies: this.#redactCookies(cookies),
    };

    this.#storage.setStorageSnapshot(snapshot);
  }

  /**
   * Captures a static DOM snapshot via `DOMSnapshot.captureSnapshot`, flattens
   * the index-array response into a well-formed `DomNode` tree, and pushes a
   * `DomSnapshot` to StorageManager.
   *
   * Pre: the debugger is attached to `tabId`. Post: one DomSnapshot is pushed
   * to StorageManager.addDomSnapshot.
   *
   * The CDP call is wrapped in try/catch: a failing query records a privacy
   * limitation and returns without pushing a snapshot so recording continues.
   *
   * After flattening, the tree is masked (`maskDomSelectors` + sensitive
   * attribute/text redaction) and checked against depth/size guards (R7.4): a
   * snapshot that exceeds a guard is skipped (not buffered) and a limitation is
   * recorded so the package stays uploadable.
   */
  async captureDomSnapshot(tabId: number, label: string): Promise<void> {
    const debuggee: chrome.debugger.Debuggee = { tabId };

    let result: CdpDomSnapshotResult | undefined;
    try {
      result = (await chrome.debugger.sendCommand(debuggee, "DOMSnapshot.captureSnapshot", {
        computedStyles: [], // no styles needed for a static tree
        includePaintOrder: false,
        includeDOMRects: false,
      })) as CdpDomSnapshotResult | undefined;
    } catch {
      this.#recordStorageLimitation(
        "DOM snapshot was skipped because the DOMSnapshot query failed.",
      );
      return;
    }
    if (!result) return;

    const root = this.#flattenDomSnapshot(result); // build tree from documents + strings
    const masked = this.#maskDomTree(root); // mask selectors + redact sensitive values

    const limitReason = this.#domTreeLimitExceeded(masked);
    if (limitReason) {
      this.#recordStorageLimitation(
        `DOM snapshot "${label}" was skipped because it exceeded the ${limitReason} limit.`,
      );
      return;
    }

    this.#storage.addDomSnapshot({
      label,
      capturedAt: Date.now(),
      documentUrl: this.#documentUrlFromSnapshot(result),
      root: masked,
    });
  }

  /**
   * Converts the `DOMSnapshot.captureSnapshot` index-array structure
   * (documents[0].nodes aligned arrays + shared `strings` table) into a
   * well-formed `DomNode` tree.
   *
   * Tree invariants (R7.2 / Property P5): each DomNode is appended to at most
   * one parent's `children`, and a child is only linked to a strictly-earlier
   * node (`parentIndex < i`, which CDP guarantees by emitting nodes in document
   * order). That bound makes cycles impossible, so the result is always a tree.
   * Only the main document (`documents[0]`) is flattened; cross-origin iframe
   * subtrees are out of scope.
   */
  #flattenDomSnapshot(result: CdpDomSnapshotResult): DomNode {
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

  /**
   * Masks a flattened DomNode tree in place and returns it (R1.5, R7.3).
   *
   * Two redaction passes run while walking the tree:
   *  1. Masking — any element node matching one of `maskDomSelectors` has
   *     `masked = true` and its `nodeValue` + every attribute value replaced
   *     with `REDACTED_VALUE`. The match propagates down the subtree so a
   *     masked element never exposes the text of its descendants (text lives in
   *     child `#text` nodes). One redaction hit (`action: "masked"`) is recorded
   *     per masked node.
   *  2. Sensitive-value redaction — for nodes NOT under a masked subtree, when
   *     `redactDomTextContent` is enabled (mirrors how storage gates on
   *     `redactStorageValues`), `nodeValue` text and each attribute value are
   *     run through the shared `redactJsonValue` policy so sensitive attribute
   *     names (via `classifyKey`) and value patterns (emails, tokens, …) are
   *     redacted. Hits are recorded with `artifact = "dom"`.
   *
   * Selector support is pragmatic/best-effort: simple compound selectors built
   * from tag (`div`), id (`#id`), class (`.class`) and attribute (`[data-x]`,
   * `[type=text]`) parts, plus combinations (`tag.class[attr]`). Combinators
   * (descendant/child/sibling) are not fully supported — the rightmost compound
   * is matched as a best effort, consistent with masking being best-effort.
   */
  #maskDomTree(root: DomNode): DomNode {
    const selectors = normalizeMaskDomSelectors(this.#privacySettings.maskDomSelectors);
    const compounds = selectors
      .map((selector) => this.#parseCompoundSelector(selector))
      .filter((compound): compound is CompoundSelector => compound !== null);
    const redactText = this.#captureSettings.redactDomTextContent;
    const hits: RedactionHit[] = [];

    const walk = (node: DomNode, inMaskedSubtree: boolean): void => {
      const masked =
        inMaskedSubtree || (compounds.length > 0 && this.#nodeMatchesCompounds(node, compounds));

      if (masked) {
        node.masked = true;
        let changed = false;
        if (node.nodeValue !== undefined && node.nodeValue !== "") {
          node.nodeValue = REDACTED_VALUE;
          changed = true;
        }
        if (node.attributes) {
          for (const name of Object.keys(node.attributes)) {
            if (node.attributes[name] !== "") {
              node.attributes[name] = REDACTED_VALUE;
              changed = true;
            }
          }
        }
        if (changed) {
          hits.push({
            artifact: "dom",
            class: "custom",
            action: "masked",
            field: "dom.node",
            ruleId: "mask-dom-selector",
          });
        }
      } else if (redactText) {
        this.#redactDomNodeValues(node, hits);
      }

      if (node.children) {
        for (const child of node.children) {
          walk(child, masked);
        }
      }
    };

    walk(root, false);
    if (hits.length > 0) {
      this.#recordRedactionHits(hits);
    }
    return root;
  }

  /**
   * Applies the shared `redactJsonValue` policy to an unmasked node's text
   * content and attribute values. Sensitive attribute names are classified via
   * `classifyKey` by wrapping the value as `{ [name]: value }` (same pattern as
   * `#redactStorageItems`); value-based rules still match the wrapped value.
   */
  #redactDomNodeValues(node: DomNode, hits: RedactionHit[]): void {
    if (node.nodeValue !== undefined && node.nodeValue !== "") {
      const result = redactJsonValue(
        node.nodeValue,
        this.#privacySettings,
        "dom",
        "dom.nodeValue",
        "body",
      );
      if (result.applied.length > 0) {
        node.nodeValue = typeof result.value === "string" ? result.value : String(result.value);
        hits.push(...result.applied);
      }
    }
    if (!node.attributes) return;
    for (const name of Object.keys(node.attributes)) {
      const value = node.attributes[name];
      if (!value) continue;
      const result = redactJsonValue(
        { [name]: value },
        this.#privacySettings,
        "dom",
        `dom.attributes.${name}`,
        "body",
      );
      if (result.applied.length > 0) {
        const redacted = (result.value as Record<string, unknown>)[name];
        node.attributes[name] = typeof redacted === "string" ? redacted : String(redacted);
        hits.push(...result.applied);
      }
    }
  }

  /**
   * Returns true when an element node matches any of the parsed compound
   * selectors. Only element nodes (`nodeType === 1`) can match because the
   * supported selector forms key off tag/id/class/attributes.
   */
  #nodeMatchesCompounds(node: DomNode, compounds: CompoundSelector[]): boolean {
    if (node.nodeType !== 1) return false;
    return compounds.some((compound) => this.#nodeMatchesCompound(node, compound));
  }

  #nodeMatchesCompound(node: DomNode, compound: CompoundSelector): boolean {
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

  /**
   * Parses a single CSS selector into a compound matcher. For selectors with
   * combinators (whitespace, `>`, `+`, `~`) only the rightmost compound is
   * parsed (best-effort). Returns null when the selector cannot be fully parsed
   * into the supported forms so it is simply ignored rather than over-matching.
   */
  #parseCompoundSelector(selector: string): CompoundSelector | null {
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

    // Require the whole compound to be consumed so unsupported syntax (e.g.
    // pseudo-classes like `:hover`) is rejected instead of partially matched.
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

  /**
   * Returns the name of the first depth/size guard the tree violates, or null
   * when the tree is within all guards. Used to skip oversized snapshots and
   * record a limitation (R7.4).
   */
  #domTreeLimitExceeded(root: DomNode): "depth" | "node count" | "size" | null {
    let nodeCount = 0;
    let maxDepth = 0;
    const stack: Array<{ node: DomNode; depth: number }> = [{ node: root, depth: 1 }];
    while (stack.length > 0) {
      const { node, depth } = stack.pop() as { node: DomNode; depth: number };
      nodeCount += 1;
      if (depth > maxDepth) maxDepth = depth;
      if (maxDepth > MAX_DOM_TREE_DEPTH) return "depth";
      if (nodeCount > MAX_DOM_TREE_NODES) return "node count";
      if (node.children) {
        for (const child of node.children) {
          stack.push({ node: child, depth: depth + 1 });
        }
      }
    }
    if (JSON.stringify(root).length > MAX_DOM_TREE_SERIALIZED_BYTES) {
      return "size";
    }
    return null;
  }

  /**
   * Resolves the snapshot's document URL from the shared `strings` table.
   * Returns an empty string when the snapshot has no document URL.
   */
  #documentUrlFromSnapshot(result: CdpDomSnapshotResult): string {
    const strings = result.strings ?? [];
    const index = result.documents?.[0]?.documentURL;
    if (index !== undefined && index >= 0 && index < strings.length) {
      return strings[index] ?? "";
    }
    return "";
  }

  async #getDomStorageItems(
    debuggee: chrome.debugger.Debuggee,
    securityOrigin: string,
    isLocalStorage: boolean,
  ): Promise<[string, string][]> {
    try {
      const result = (await chrome.debugger.sendCommand(debuggee, "DOMStorage.getDOMStorageItems", {
        storageId: { securityOrigin, isLocalStorage },
      })) as CdpDomStorageItemsResult | undefined;
      return result?.entries ?? [];
    } catch {
      this.#recordStorageLimitation(
        `${
          isLocalStorage ? "localStorage" : "sessionStorage"
        } snapshot was skipped because the storage query failed.`,
      );
      return [];
    }
  }

  /**
   * Fetches the whole cookie jar and filters it to the tab's domain to reduce
   * the PII surface captured into the artifact. A failed query records a
   * limitation and returns no cookies so recording can continue.
   */
  async #getAllCookies(debuggee: chrome.debugger.Debuggee, hostname: string): Promise<CdpCookie[]> {
    try {
      const result = (await chrome.debugger.sendCommand(debuggee, "Network.getAllCookies")) as
        | CdpCookiesResult
        | undefined;
      return this.#filterCookiesByDomain(result?.cookies ?? [], hostname);
    } catch {
      this.#recordStorageLimitation("Cookie snapshot was skipped because the cookie query failed.");
      return [];
    }
  }

  /**
   * Resolves the tab's security origin (and hostname) from the tab URL so that
   * `DOMStorage.getDOMStorageItems` targets the correct storage and cookies can
   * be filtered to the tab domain. Cross-origin iframes are out of scope here.
   */
  async #resolveSecurityOrigin(tabId: number): Promise<{ origin: string; hostname: string }> {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab?.url) {
        const url = new URL(tab.url);
        return { origin: url.origin, hostname: url.hostname };
      }
    } catch {
      // Tab may have been closed; fall through to an empty origin.
    }
    return { origin: "", hostname: "" };
  }

  #filterCookiesByDomain(cookies: CdpCookie[], hostname: string): CdpCookie[] {
    if (!hostname) return cookies;
    return cookies.filter((cookie) => this.#cookieDomainMatches(cookie.domain, hostname));
  }

  #cookieDomainMatches(cookieDomain: string | undefined, hostname: string): boolean {
    if (!cookieDomain) return false;
    const normalized = cookieDomain.startsWith(".") ? cookieDomain.slice(1) : cookieDomain;
    return hostname === normalized || hostname.endsWith(`.${normalized}`);
  }

  #redactStorageItems(entries: [string, string][], fieldPrefix: string): StorageKeyValue[] {
    return entries.map(([key, value]) => {
      if (!this.#captureSettings.redactStorageValues) {
        return { key, value };
      }
      // Reuse redactJsonValue by wrapping the value in `{ [key]: value }` so the
      // shared policy classifies the storage key by name and still applies
      // value-based rules to the value. artifact = "storage", target = "body".
      const result = redactJsonValue(
        { [key]: value },
        this.#privacySettings,
        "storage",
        fieldPrefix,
        "body",
      );
      if (result.applied.length > 0) {
        this.#recordRedactionHits(result.applied);
      }
      const redactedValue = (result.value as Record<string, unknown>)[key];
      return {
        key,
        value: typeof redactedValue === "string" ? redactedValue : String(redactedValue),
        redacted: result.applied.length > 0 ? true : undefined,
      };
    });
  }

  #redactCookies(cookies: CdpCookie[]): CookieRecord[] {
    return cookies.map((cookie) => {
      const record: CookieRecord = {
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        expires: cookie.expires,
        size: cookie.size,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        sameSite: this.#normalizeSameSite(cookie.sameSite),
      };
      if (!this.#captureSettings.redactStorageValues) {
        return record;
      }
      // Wrap as `{ [name]: value }` so a sensitive cookie name (e.g. session,
      // token, csrf) redacts the value, and value-based rules still match.
      const result = redactJsonValue(
        { [cookie.name]: cookie.value },
        this.#privacySettings,
        "storage",
        "storage.cookies",
        "body",
      );
      if (result.applied.length > 0) {
        this.#recordRedactionHits(result.applied);
      }
      const redactedValue = (result.value as Record<string, unknown>)[cookie.name];
      record.value = typeof redactedValue === "string" ? redactedValue : String(redactedValue);
      record.redacted = result.applied.length > 0 ? true : undefined;
      return record;
    });
  }

  #recordStorageLimitation(message: string): void {
    if (!message || this.#storageLimitations.includes(message)) {
      return;
    }
    this.#storageLimitations.push(message);
  }

  #normalizeSameSite(sameSite: string | undefined): CookieRecord["sameSite"] {
    if (sameSite === "Strict" || sameSite === "Lax" || sameSite === "None") {
      return sameSite;
    }
    return undefined;
  }
}
