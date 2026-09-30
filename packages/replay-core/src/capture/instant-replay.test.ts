/**
 * Instant replay tests.
 *
 * The behaviours worth pinning are the ones a reader would otherwise be misled
 * by: how much history the buffer actually holds when the byte cap bites, that
 * it never empties itself completely, and that a page too heavy to snapshot
 * turns the recorder off instead of dragging the page down with it.
 */

import { describe, expect, it } from "vitest";
import { serializeDomTree } from "./dom-snapshot";
import { InstantReplayBuffer, startInstantReplay } from "./instant-replay";

/**
 * A hand-built DOM, not jsdom.
 *
 * `serializeDomTree` touches a small, explicit slice of the DOM API, and the
 * rest of this package's capture tests already inject a fake scope rather than
 * pulling in a browser environment. Building the tree by hand keeps that
 * convention and makes it obvious which API surface the serializer is allowed
 * to depend on — if it starts reaching for something else, these tests break
 * loudly instead of quietly passing against jsdom's fuller implementation.
 */
interface FakeNode {
  nodeType: number;
  nodeName: string;
  nodeValue?: string;
  childNodes: FakeNode[];
}

interface FakeElement extends FakeNode {
  tagName: string;
  attributes: Array<{ name: string; value: string }>;
  value?: string;
  matches(selector: string): boolean;
  getAttribute(name: string): string | null;
}

function el(
  tagName: string,
  options: {
    attributes?: Record<string, string>;
    children?: FakeNode[];
    value?: string;
    classes?: string[];
  } = {},
): FakeElement {
  const attributes = Object.entries(options.attributes ?? {}).map(([name, value]) => ({
    name,
    value,
  }));
  if (options.classes?.length) {
    attributes.push({ name: "class", value: options.classes.join(" ") });
  }

  const node: FakeElement = {
    nodeType: 1,
    nodeName: tagName.toUpperCase(),
    tagName: tagName.toUpperCase(),
    attributes,
    childNodes: options.children ?? [],
    matches(selector: string) {
      if (selector.startsWith(".")) {
        return (options.classes ?? []).includes(selector.slice(1));
      }
      return selector.toUpperCase() === this.tagName;
    },
    getAttribute(name: string) {
      return attributes.find((attribute) => attribute.name === name)?.value ?? null;
    },
  };
  if (options.value !== undefined) {
    node.value = options.value;
  }
  return node;
}

function text(value: string): FakeNode {
  return { nodeType: 3, nodeName: "#text", nodeValue: value, childNodes: [] };
}

/** A `Document`-shaped wrapper: the serializer only reads `documentElement`. */
function doc(root: FakeElement): Document {
  return { documentElement: root } as unknown as Document;
}

function frame(capturedAt: number) {
  return {
    capturedAt,
    documentUrl: "https://shop.test/checkout",
    viewport: { width: 390, height: 844 },
    root: { nodeType: 1, nodeName: "HTML" },
  };
}

describe("InstantReplayBuffer", () => {
  it("evicts frames older than the window", () => {
    const buffer = new InstantReplayBuffer({ windowMs: 5_000 });
    for (let index = 0; index < 10; index += 1) {
      buffer.push(frame(1_000 + index * 1_000), 100);
    }

    const artifact = buffer.toArtifact();
    expect(artifact.coveredMs).toBeLessThanOrEqual(5_000);
    expect(artifact.droppedFrames).toBeGreaterThan(0);
    expect(artifact.frames[artifact.frames.length - 1].capturedAt).toBe(10_000);
  });

  it("reports the covered span it actually holds, not the configured window", () => {
    // Byte cap bites long before the time window does.
    const buffer = new InstantReplayBuffer({ windowMs: 60_000, maxBytes: 250 });
    for (let index = 0; index < 10; index += 1) {
      buffer.push(frame(1_000 + index * 1_000), 100);
    }

    const artifact = buffer.toArtifact();
    expect(artifact.windowMs).toBe(60_000);
    // Only ~2 frames fit, so the honest coverage is ~1s, not 60s.
    expect(artifact.coveredMs).toBeLessThan(5_000);
    expect(artifact.frames.length).toBeLessThanOrEqual(3);
  });

  it("never evicts the last frame, however tight the caps", () => {
    const buffer = new InstantReplayBuffer({ windowMs: 1, maxBytes: 1 });
    buffer.push(frame(1_000), 10_000);
    buffer.push(frame(9_000), 10_000);

    expect(buffer.frameCount).toBe(1);
    expect(buffer.toArtifact().frames[0].capturedAt).toBe(9_000);
  });

  it("numbers frames from the first retained one", () => {
    const buffer = new InstantReplayBuffer({ windowMs: 60_000 });
    buffer.push(frame(5_000), 10);
    buffer.push(frame(6_500), 10);

    const artifact = buffer.toArtifact();
    expect(artifact.frames[0].relativeMs).toBe(0);
    expect(artifact.frames[1].relativeMs).toBe(1_500);
  });
});

/** Minimal scope: a fake interval plus a document the serializer can walk. */
function createScope(root: FakeElement, snapshotCostMs = 0) {
  const timers: Array<() => void> = [];
  let clock = 0;

  return {
    scope: {
      document: doc(root),
      location: { href: "https://shop.test/checkout" },
      innerWidth: 390,
      innerHeight: 844,
      setInterval: (handler: () => void) => {
        timers.push(handler);
        return timers.length;
      },
      clearInterval: () => {
        timers.length = 0;
      },
      performance: {
        now: () => {
          // Each call advances; a snapshot reads start and end, so the pair
          // differs by `snapshotCostMs`.
          const value = clock;
          clock += snapshotCostMs;
          return value;
        },
      },
    },
    tick: () => {
      for (const handler of [...timers]) {
        handler();
      }
    },
    hasTimers: () => timers.length > 0,
  };
}

describe("startInstantReplay", () => {
  it("captures the page on each tick", () => {
    const { scope, tick } = createScope(
      el("html", { children: [el("h1", { children: [text("Checkout")] })] }),
    );
    const recorder = startInstantReplay(scope, { windowMs: 30_000 }, () => Date.now());

    tick();
    tick();

    expect(recorder.buffer.frameCount).toBe(2);
    const artifact = recorder.toArtifact();
    expect(artifact?.frames[0].documentUrl).toBe("https://shop.test/checkout");
    recorder.stop();
  });

  it("returns null rather than an empty artifact when nothing was captured", () => {
    const { scope } = createScope(el("html"));
    const recorder = startInstantReplay(scope);
    expect(recorder.toArtifact()).toBeNull();
    recorder.stop();
  });

  it("disables itself on a page too heavy to snapshot", () => {
    const { scope, tick, hasTimers } = createScope(
      el("html", { children: [el("p", { children: [text("heavy")] })] }),
      500, // every snapshot "costs" 500ms
    );
    const recorder = startInstantReplay(scope, {
      maxSnapshotMs: 50,
      maxConsecutiveOverruns: 2,
    });

    tick();
    expect(recorder.disabled).toBe(false);
    tick();

    expect(recorder.disabled).toBe(true);
    expect(recorder.disabledReason).toMatch(/instant replay disabled/i);
    // And it actually stopped, rather than just flagging itself.
    expect(hasTimers()).toBe(false);
    expect(recorder.snapshot()).toBe(false);
  });

  it("clears the buffer on demand so history never lingers", () => {
    const { scope, tick } = createScope(
      el("html", { children: [el("p", { children: [text("x")] })] }),
    );
    const recorder = startInstantReplay(scope);
    tick();
    expect(recorder.buffer.frameCount).toBe(1);

    recorder.buffer.clear();
    expect(recorder.buffer.frameCount).toBe(0);
    expect(recorder.toArtifact()).toBeNull();
    recorder.stop();
  });
});

describe("serializeDomTree", () => {
  it("drops script bodies so a replayed snapshot cannot execute the page", () => {
    const tree = el("html", {
      children: [
        el("script", { children: [text("steal()")] }),
        el("p", { children: [text("hello")] }),
      ],
    });
    const json = JSON.stringify(serializeDomTree(doc(tree)).root);
    expect(json).not.toContain("steal()");
    expect(json).toContain("hello");
  });

  it("keeps a password field visible but never its contents", () => {
    const tree = el("html", {
      children: [el("input", { attributes: { type: "password" }, value: "hunter2" })],
    });

    const json = JSON.stringify(serializeDomTree(doc(tree), { includeFormValues: true }).root);
    expect(json).not.toContain("hunter2");
    expect(json).toContain("data-gn-tracing-masked");
    expect(json).toContain("INPUT");
  });

  it("omits typed values entirely unless the caller opts in", () => {
    const tree = el("html", {
      children: [el("input", { attributes: { type: "text" }, value: "order 12345" })],
    });

    expect(JSON.stringify(serializeDomTree(doc(tree)).root)).not.toContain("order 12345");
    expect(JSON.stringify(serializeDomTree(doc(tree), { includeFormValues: true }).root)).toContain(
      "order 12345",
    );
  });

  it("replaces a masked subtree with a marker instead of its content", () => {
    const tree = el("html", {
      children: [
        el("div", { classes: ["secret"], children: [el("p", { children: [text("card 4111")] })] }),
        el("p", { children: [text("ok")] }),
      ],
    });
    const json = JSON.stringify(serializeDomTree(doc(tree), { maskSelectors: [".secret"] }).root);

    expect(json).not.toContain("4111");
    expect(json).toContain('"masked":true');
    expect(json).toContain("ok");
  });

  it("reports truncation rather than silently returning a partial tree", () => {
    const items = Array.from({ length: 200 }, (_, index) =>
      el("li", { children: [text(`item ${index}`)] }),
    );
    const tree = el("html", { children: [el("ul", { children: items })] });

    const result = serializeDomTree(doc(tree), { maxNodes: 25 });
    expect(result.truncated).toBe(true);
    expect(result.nodeCount).toBeLessThanOrEqual(26);
  });
});
